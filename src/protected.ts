import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import type { Scene } from "@babylonjs/core/scene";
import type { ISceneLoaderAsyncResult } from "@babylonjs/core/Loading/sceneLoader";

/**
 * Shipping the assets without shipping the assets.
 *
 * Every file in a built game is a finished asset sitting in a folder: an APK
 * is a zip anyone can open, and a deployed build answers a GET for any path in
 * it. `scripts/protect-assets.mjs` encrypts them at build time into `.teq`
 * files and this decrypts them on the way into Babylon, the audio element and
 * the DOM.
 *
 * **AES-256-GCM**, through WebCrypto — real, authenticated encryption. Without
 * the key an encrypted asset is indistinguishable from random bytes: there is
 * no header to recognise, no structure to guess at, and no way to unpick it
 * from the file alone. A single altered byte fails the authentication tag
 * rather than producing plausible rubbish. A fresh random IV per file, because
 * GCM requires one and these files come in groups that share a header byte for
 * byte — the glTF magic on every model, the WebP one on every texture.
 *
 * It covers **every shipped asset**, not the models alone. Encrypting the
 * `.glb` files while serving the textures, the venue cards, the music and the
 * intro clip in the open beside them protected the expensive third of a build
 * and left the rest in a folder for anybody who typed the path.
 *
 * **The honest caveat is key distribution, not the cipher.** A packaged game
 * has to decrypt its own assets on a phone in a tunnel, so the key ships
 * inside the bundle; anybody willing to read the JavaScript and drive
 * WebCrypto themselves can recover it. That is a property of client-side
 * decryption in general and not of this scheme — the only design without it is
 * one where the assets never reach the client in usable form, which for a
 * WebGL game does not exist. **Nothing here makes a build unrippable, and it
 * should not be described as if it did.**
 *
 * What it does buy:
 *
 * - a `.teq` is noise, so nothing is one rename away from being openable;
 * - the key cannot be recovered from the *files*, only from the bundle, which
 *   is a different and much higher bar than reading a header;
 * - tampering is detected rather than silently loaded;
 * - the licensed packs are not distributed in "a file format usable by any 3D
 *   application", which is the specific thing their licence forbids.
 *
 * The part that is *not* a caveat is the repository. The plaintext art is no
 * longer committed — see `scripts/fetch-assets.mjs` — so reading this code,
 * however carefully, yields the scheme and no assets to apply it to.
 *
 * Hardware AES is standard on every ARMv8 phone, so decryption runs at
 * hundreds of MB/s and the whole set costs a fraction of a second spread
 * across the loads that need it.
 */

/**
 * The passphrase, and where it comes from.
 *
 * `VITE_ASSET_KEY` at build time, with no fallback: a default here is the
 * value a release actually ships with, because a variable nothing sets is a
 * variable that is never set. This one shipped in every build until
 * `scripts/protect-assets.mjs` started refusing to run without it.
 *
 * Empty in an unprotected build, which never reaches `assetKey`.
 */
const PASSPHRASE = import.meta.env.VITE_ASSET_KEY ?? "";

/** Whether this build's assets were encrypted. Set by the build script. */
export const PROTECTED = import.meta.env.VITE_PROTECTED_ASSETS === "1";

/** The extension an encrypted asset wears. Deliberately not `.glb`. */
export const PROTECTED_EXT = ".teq";

/** Bytes of IV on the front, and authentication tag on the end. */
export const IV_BYTES = 12;
export const TAG_BYTES = 16;

/**
 * Which files the build encrypted, by extension.
 *
 * The mirror of `PROTECTED_EXTENSIONS` in `scripts/scramble.mjs`. The two
 * being one list in two places is the same hazard as the cipher being written
 * twice, and it fails the same silent way: an extension the build encrypts and
 * this does not is a 404 in a release build and nowhere else.
 * `tests/protected.test.ts` compares them.
 */
export const PROTECTED_EXTENSIONS = [
  ".glb",
  ".vat",
  ".webp",
  ".jpg",
  ".mp3",
  ".wav",
  ".mp4",
] as const;

/**
 * Content types for the protected extensions.
 *
 * A decrypted `Blob` carries whatever type it is given and nothing else — the
 * bytes are not sniffed. An `<audio>` handed a typeless blob will not play it
 * on iOS, and a `<video>` will not start; getting this wrong fails only on a
 * device, only in a release build, and looks like a broken asset rather than a
 * missing MIME type.
 */
const CONTENT_TYPES: Record<string, string> = {
  ".glb": "model/gltf-binary",
  ".vat": "application/octet-stream",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
};

/** The extension of a path, lowercased, including the dot. */
function extensionOf(path: string): string {
  const clean = path.split(/[?#]/, 1)[0];
  const dot = clean.lastIndexOf(".");
  return dot === -1 ? "" : clean.slice(dot).toLowerCase();
}

/** Whether this build serves this path encrypted. */
export function isProtectedAsset(path: string): boolean {
  return (PROTECTED_EXTENSIONS as readonly string[]).includes(extensionOf(path));
}

/**
 * The URL to actually fetch for a logical asset path.
 *
 * `/models/x.glb` becomes `/models/x.glb.teq` in a protected build and stays
 * itself in a plain one. Anything outside the protected set — the fonts, the
 * meshopt decoder — is returned untouched in both.
 */
export function sourceUrl(path: string): string {
  return PROTECTED && isProtectedAsset(path) ? `${path}${PROTECTED_EXT}` : path;
}

/**
 * The AES key for a passphrase, derived once and kept.
 *
 * SHA-256 rather than a KDF with a work factor: a work factor protects a
 * *secret* passphrase from brute force, and this one ships in the bundle.
 * Stretching it would cost startup time on a phone and buy nothing.
 */
let keyPromise: Promise<CryptoKey> | null = null;
function assetKey(): Promise<CryptoKey> {
  keyPromise ??= (async () => {
    // A protected build with no key decrypts every asset to a thrown error.
    // Saying so once beats the same failure arriving as thirty broken loads.
    if (!PASSPHRASE) {
      throw new Error(
        "This build is marked protected but carries no VITE_ASSET_KEY — no asset can be decrypted."
      );
    }
    const raw = new TextEncoder().encode(PASSPHRASE);
    const digest = await crypto.subtle.digest("SHA-256", raw);
    return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["decrypt"]);
  })();
  return keyPromise;
}

/**
 * Decrypt one asset.
 *
 * WebCrypto expects the tag appended to the ciphertext, which is the layout
 * the build script writes — so the body is everything after the IV, tag
 * included, and `decrypt` verifies it before returning a byte.
 */
export async function decryptAsset(file: ArrayBuffer): Promise<ArrayBuffer> {
  const bytes = new Uint8Array(file);
  const iv = bytes.subarray(0, IV_BYTES);
  const body = bytes.subarray(IV_BYTES);
  return crypto.subtle.decrypt({ name: "AES-GCM", iv }, await assetKey(), body);
}

/**
 * The bytes of an asset, decrypted if this build encrypted them.
 *
 * For the callers that want the file itself rather than something to point an
 * element at — the crowd's baked animation textures, which are parsed as raw
 * floats and never become a URL.
 */
export async function assetBuffer(path: string): Promise<ArrayBuffer> {
  const url = sourceUrl(path);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  const raw = await response.arrayBuffer();
  return PROTECTED && isProtectedAsset(path) ? decryptAsset(raw) : raw;
}

/**
 * A URL that any DOM element will accept for a logical asset path.
 *
 * In a plain build this is the path, unchanged — the dev server serves
 * `assets/` directly, and returning it untouched keeps range requests working,
 * which is how a `<video>` starts playing before it has the whole file.
 *
 * In a protected build the file is fetched, decrypted and wrapped in a
 * `blob:` URL. That costs the whole file up front, which is the honest price
 * of not shipping it readable.
 *
 * Blob URLs are cached and deliberately never revoked. These are a fixed,
 * small set — four music loops, two sounds, eight textures, four venue cards,
 * one clip — every one of which is used repeatedly across a session; revoking
 * would mean re-fetching and re-decrypting each time a texture is rebuilt, and
 * the leak is bounded by the asset list rather than by anything the player
 * does. Sharing one promise per path also means a texture requested twice in
 * the same frame is fetched once.
 */
const urlCache = new Map<string, Promise<string>>();
export function assetUrl(path: string): Promise<string> {
  if (!PROTECTED || !isProtectedAsset(path)) return Promise.resolve(path);
  let cached = urlCache.get(path);
  if (!cached) {
    cached = (async () => {
      const plain = await assetBuffer(path);
      const type = CONTENT_TYPES[extensionOf(path)] ?? "application/octet-stream";
      return URL.createObjectURL(new Blob([plain], { type }));
    })();
    // A failed decrypt must not be cached, or one flaky fetch breaks the asset
    // for the rest of the session.
    cached.catch(() => urlCache.delete(path));
    urlCache.set(path, cached);
  }
  return cached;
}

/**
 * Warm the cache for an asset without waiting for it or caring if it fails.
 *
 * The intro clip's four seconds are cover for downloading the character
 * models, and this is what does the downloading. It replaces a `<link
 * rel=prefetch>` on the `.glb` URL, which in a protected build pointed at a
 * path that does not exist: every prefetch in every release 404ed silently,
 * and the picker opened on a model it still had to fetch.
 */
export function prefetchAsset(path: string): void {
  void assetUrl(path).catch(() => undefined);
}

/**
 * Load a model, encrypted or not.
 *
 * The unprotected path is the original call, untouched. The protected path
 * fetches the `.teq`, decrypts it and hands Babylon a `File`, which the glTF
 * loader accepts exactly as it accepts a URL. These models are self-contained
 * (their textures are embedded), so no root URL is left for anything to
 * resolve.
 */
export async function importModel(
  scene: Scene,
  dir: string,
  file: string
): Promise<ISceneLoaderAsyncResult> {
  const source = await protectedSource(dir, file);
  if (!source) return SceneLoader.ImportMeshAsync("", dir, file, scene);
  return SceneLoader.ImportMeshAsync("", "", source, scene);
}

/**
 * The decrypted model as a `File`, or null when this build ships them plain.
 *
 * For the one loader that cannot go through `importModel`: the model viewer
 * needs the newer `ImportMeshAsync` overload so it can pass plugin options,
 * and a loader that both takes a source and needs its own options is easier to
 * hand a source than to wrap.
 */
export async function protectedSource(dir: string, file: string): Promise<File | null> {
  if (!PROTECTED) return null;
  const plain = await assetBuffer(`${dir}${file}`);
  return new File([plain], file, { type: "model/gltf-binary" });
}
