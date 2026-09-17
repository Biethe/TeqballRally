// Write a lighter copy of each heavy model into a build, for phones.
//
//   vite build && node scripts/lite-models.mjs [dist]
//
// The players were sculpted for a close-up: 90k to 190k triangles each, and
// the gym backdrop is another 295k. A match draws both players twice (the
// shadow map is a second pass over them), so an entry-level phone was pushing
// well over a million triangles a frame and drew sixteen frames a second — in
// a match against the AI, with no network involved. At the size a player
// stands on a phone screen, a sixth of the triangles is the same picture.
//
// Copies, not replacements: the desktop tier keeps the full models, and the
// game falls back to the full model wherever a copy is missing — which is
// every dev-server session, since this only runs over a build. Runs before
// `protect-assets.mjs`, so the copies are encrypted like everything else.
//
// Generated from whatever art the build has rather than packed into the art
// bundle, so CI and a local build cannot disagree about whether they exist.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { simplify, textureCompress, weld } from "@gltf-transform/functions";
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from "meshoptimizer";
// A dependency of @gltf-transform/functions itself, so wherever that installs
// this does too.
import sharp from "sharp";

const ROOT = process.argv[2] ?? "dist";

/**
 * Which models, and how hard. `ratio` is the share of the model to aim for;
 * `error` bounds how far any surface may move, as a fraction of the model's
 * size, and wins when the two disagree — so a model whose detail is all
 * silhouette stops early rather than losing its shape.
 *
 * `textures` caps texture size. Each player carries a dozen 1024px maps —
 * about fifty megabytes of GPU memory apiece once uploaded, on a phone with
 * three gigabytes for everything — for a figure a few hundred pixels tall.
 */
const TARGETS = [
  { dir: "models/characters", match: /Player\.glb$/, ratio: 0.15, error: 0.01, textures: 512 },
  { dir: "models/Ball_and_Table", match: /Ball\.glb$/, ratio: 0.1, error: 0.01 },
  // Not the arenas, though they are the other big number. Their triangles are
  // thousands of separate seats and boards, and the simplifier can only thin a
  // piece by eating it: the stands came out as grey stubble. Locking the pieces'
  // edges kept them whole and saved nine per cent.
];

/** Must match `liteModelFile` in src/protected.ts. */
const liteName = (file) => file.replace(/\.glb$/, ".lite.glb");

await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready, MeshoptSimplifier.ready]);
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ "meshopt.decoder": MeshoptDecoder, "meshopt.encoder": MeshoptEncoder });

const triangles = (doc) => {
  let n = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const p of mesh.listPrimitives()) {
      const idx = p.getIndices();
      n += (idx ? idx.getCount() : (p.getAttribute("POSITION")?.getCount() ?? 0)) / 3;
    }
  }
  return n;
};

let written = 0;
for (const { dir, match, ratio, error, textures } of TARGETS) {
  const base = join(ROOT, dir);
  // A build without the art (a fresh clone, `build:plain`) has nothing to thin,
  // and the game already copes with the copies being absent.
  if (!existsSync(base)) continue;
  for (const file of readdirSync(base)) {
    if (!match.test(file) || file.endsWith(".lite.glb")) continue;
    const doc = await io.read(join(base, file));
    const before = triangles(doc);
    await doc.transform(
      weld(),
      simplify({ simplifier: MeshoptSimplifier, ratio, error }),
      ...(textures ? [textureCompress({ encoder: sharp, resize: [textures, textures] })] : [])
    );
    await io.write(join(base, liteName(file)), doc);
    console.log(`  ${dir}/${file}: ${before} -> ${triangles(doc)} triangles`);
    written++;
  }
}
console.log(`${written} lite model(s) written`);
