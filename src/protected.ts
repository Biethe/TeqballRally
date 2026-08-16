import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import type { Scene } from "@babylonjs/core/scene";
import type { ISceneLoaderAsyncResult } from "@babylonjs/core/Loading/sceneLoader";

/**
 * Shipping the models without shipping the models.
 *
 * Every `.glb` in a built game is a finished 3D asset sitting in a folder: a
 * public repository hands them over with a click, and an APK is a zip anyone
 * can open. `scripts/protect-assets.mjs` encrypts them at build time into
 * `.teq` files and this decrypts them on the way into Babylon.
 *
 * **AES-256-GCM**, through WebCrypto — real, authenticated encryption. Without
 * the key an encrypted model is indistinguishable from random bytes: there is
 * no header to recognise, no structure to guess at, and no way to unpick it
 * from the file alone. A single altered byte fails the authentication tag
 * rather than producing plausible rubbish. A fresh random IV per file, because
 * GCM requires one and every model here starts with the same glTF header.
 *
 * **The honest caveat is key distribution, not the cipher.** A packaged game
 * has to decrypt its own models on a phone in a tunnel, so the key ships
 * inside the bundle; anybody willing to read the JavaScript and drive
 * WebCrypto themselves can recover it. That is a property of client-side
 * decryption in general and not of this scheme — the only design without it is
 * one where the models never reach the client in usable form, which for a
 * WebGL game does not exist.
 *
 * What it does buy, and what the XOR it replaced did not:
 *
 * - a `.teq` is noise, so nothing is one rename away from being openable;
 * - the key cannot be recovered from the *files*, only from the bundle, which
 *   is a different and much higher bar than reading a header;
 * - tampering is detected rather than silently loaded;
 * - the licensed packs are not distributed in "a file format usable by any 3D
 *   application", which is the specific thing their licence forbids.
 *
 * Hardware AES is standard on every ARMv8 phone, so decryption runs at
 * hundreds of MB/s and the whole 37 MB set costs a fraction of a second
 * spread across the loads that need it.
 */

/**
 * The passphrase, and where it comes from.
 *
 * A build-time value rather than a literal so a release is at least not
 * encrypted with the string written in this repository. `VITE_ASSET_KEY` at
 * build time sets it; the fallback keeps a developer build working without
 * ceremony, and `scripts/protect-assets.mjs` uses the identical default.
 */
const PASSPHRASE = import.meta.env.VITE_ASSET_KEY ?? "teqrallly-default-key";

/** Whether this build's models were encrypted. Set by the build script. */
export const PROTECTED = import.meta.env.VITE_PROTECTED_ASSETS === "1";

/** The extension an encrypted model wears. Deliberately not `.glb`. */
export const PROTECTED_EXT = ".teq";

/** Bytes of IV on the front, and authentication tag on the end. */
export const IV_BYTES = 12;
export const TAG_BYTES = 16;

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
    const raw = new TextEncoder().encode(PASSPHRASE);
    const digest = await crypto.subtle.digest("SHA-256", raw);
    return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["decrypt"]);
  })();
  return keyPromise;
}

/**
 * Decrypt one model.
 *
 * WebCrypto expects the tag appended to the ciphertext, which is the layout
 * the build script writes — so the body is everything after the IV, tag
 * included, and `decrypt` verifies it before returning a byte.
 */
export async function decryptModel(file: ArrayBuffer): Promise<ArrayBuffer> {
  const bytes = new Uint8Array(file);
  const iv = bytes.subarray(0, IV_BYTES);
  const body = bytes.subarray(IV_BYTES);
  return crypto.subtle.decrypt({ name: "AES-GCM", iv }, await assetKey(), body);
}

/**
 * Load a model, encrypted or not.
 *
 * The unprotected path is the original call, untouched — a dev server serves
 * `assets/` directly and there is nothing to undo. The protected path fetches
 * the `.teq`, decrypts it and hands Babylon a `File`, which the glTF loader
 * accepts exactly as it accepts a URL. These models are self-contained (their
 * textures are embedded), so no root URL is left for anything to resolve.
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
  const response = await fetch(`${dir}${file}${PROTECTED_EXT}`);
  if (!response.ok) throw new Error(`${file}: ${response.status}`);
  const plain = await decryptModel(await response.arrayBuffer());
  return new File([plain], file, { type: "model/gltf-binary" });
}
