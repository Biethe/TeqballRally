import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import type { Scene } from "@babylonjs/core/scene";
import type { ISceneLoaderAsyncResult } from "@babylonjs/core/Loading/sceneLoader";

/**
 * Shipping the models without shipping the models.
 *
 * Every `.glb` in a built game is a finished 3D asset sitting in a folder: a
 * public repository hands them over with a click, and an APK is a zip that
 * anyone can open. `scripts/protect-assets.mjs` scrambles them at build time
 * into `.teq` files, and this unscrambles them on the way into Babylon.
 *
 * **This is obfuscation, not encryption, and the distinction matters.** The
 * key ships inside the bundle, because the game has to be able to read its own
 * models on a device with no network and no server to ask. Anyone willing to
 * read the JavaScript can recover it. What this actually buys:
 *
 * - a public repo, or an unzipped APK, contains nothing a 3D tool will open;
 * - nothing is one drag-and-drop away from being in somebody else's project;
 * - the licensed packs (the crowd, the props) are not sitting in the open in
 *   "a file format usable by any 3D application", which is the specific thing
 *   their licence forbids distributing.
 *
 * What it does not buy is protection from somebody who actually wants them.
 * That needs the models never to reach the client in a usable form at all,
 * which for a WebGL game is not a thing that exists.
 *
 * The scheme is a keystream XOR rather than AES-GCM on purpose. Both are
 * equally recoverable once the key is in hand, so the only real question is
 * cost: this is a single pass over the bytes with no allocation per block and
 * no crypto API, which on a mid-range phone is the difference between a
 * scrambled 18 MB character set and a visibly slower loading screen.
 */

/**
 * The key, and where it comes from.
 *
 * A build-time value rather than a literal so it is at least not the same for
 * everybody who reads this file on GitHub. `VITE_ASSET_KEY` at build time sets
 * it; the fallback keeps a developer build working without ceremony.
 */
const KEY = import.meta.env.VITE_ASSET_KEY ?? "teqrallly-default-key";

/** Whether this build's assets were scrambled. Set by the build script. */
export const PROTECTED = import.meta.env.VITE_PROTECTED_ASSETS === "1";

/** The extension a scrambled model wears. Deliberately not `.glb`. */
export const PROTECTED_EXT = ".teq";

/**
 * A 32-bit hash of the key and the file's own name.
 *
 * Per-file, so the same stretch of bytes in two models does not scramble to
 * the same thing — with one shared keystream, two files that both begin with
 * the glTF magic number would leak it immediately.
 */
export function seedFor(key: string, name: string): number {
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
 * XOR a buffer with the keystream for `name`, in place.
 *
 * Its own inverse, which is the whole reason for the shape: the build script
 * and the game run the identical function, so there is no pair of routines to
 * keep in agreement. xorshift32 for the stream — it is not a secure PRNG and
 * does not need to be, since the key is public the moment somebody opens the
 * bundle; what it needs to be is identical in Node and in a WebView, and
 * `Math.imul` and `>>> 0` make the arithmetic exact in both.
 */
export function scramble(bytes: Uint8Array, key: string, name: string): Uint8Array {
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

/**
 * Load a model, scrambled or not.
 *
 * The unprotected path is the original call, untouched — a dev server serves
 * `assets/` directly and there is nothing to undo. The protected path fetches
 * the `.teq`, unscrambles it and hands Babylon a `File`, which the glTF loader
 * accepts exactly as it accepts a URL. These models are self-contained (their
 * textures are embedded), so there is no root URL left for anything to
 * resolve against.
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
 * The unscrambled model as a `File`, or null when this build ships them plain.
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
  const bytes = new Uint8Array(await response.arrayBuffer());
  scramble(bytes, KEY, file);
  return new File([bytes], file, { type: "model/gltf-binary" });
}
