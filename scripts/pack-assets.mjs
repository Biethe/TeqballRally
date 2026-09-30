// Pack the working copy's art into one encrypted bundle, and write the
// manifest that proves a later unpack got all of it.
//
//   ASSET_BUNDLE_KEY=… node scripts/pack-assets.mjs [out.teq]
//
// Run this on a machine that *has* the art, after changing it. Upload the
// bundle somewhere private — a private repo's release asset, a bucket, a
// signed URL — and point `ASSET_BUNDLE_URL` at it. `scripts/fetch-assets.mjs`
// is the other half.
//
// Why a bundle rather than committed files: `assets/` is not in this
// repository and must not go back into it. The whole point of the exercise is
// that a public clone contains the code and none of the art, so cloning it and
// reading this script yields the scheme with nothing to apply it to.
//
// The manifest *is* committed. It is a list of paths, sizes and SHA-256
// digests — it hands over nothing, and it is what makes a missing or truncated
// asset an error at fetch time instead of a texture that never appears.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { encryptAsset, ART_SOURCE_DIR } from "./scramble.mjs";

const OUT = process.argv[2] ?? "art-bundle.teq";
const MANIFEST = "assets/manifest.json";
const KEY = process.env.ASSET_BUNDLE_KEY;

// The bundle sits in private storage, but "private storage" is a setting
// somebody can get wrong once. Encrypting it too means a bucket accidentally
// made public still leaks nothing.
if (!KEY) {
  console.error("ASSET_BUNDLE_KEY is not set — refusing to write an unencrypted art bundle.");
  process.exit(1);
}

// Both directories, because both are art and neither is in the repository:
// `assets/` is what the game loads, `art-source/` the Mixamo rigs and Blender
// exports the bakes are regenerated from.
const ROOTS = ["assets", ART_SOURCE_DIR].filter((dir) => existsSync(dir));
if (ROOTS.length === 0) {
  console.error("Nothing to pack: neither assets/ nor " + ART_SOURCE_DIR + "/ exists here.");
  process.exit(1);
}

function* walk(dir) {
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}

const files = [];
for (const root of ROOTS) {
  for (const path of walk(root)) {
    // Windows writes these beside anything downloaded through a browser, and
    // they have been committed to this repository before.
    if (path.endsWith(":Zone.Identifier")) continue;
    const bytes = readFileSync(path);
    files.push({
      path: relative(".", path).split(sep).join("/"),
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
}

// tar reads the roots from disk rather than the list above, so the two can
// only disagree if something changes underfoot mid-run. `-` writes to stdout;
// `maxBuffer` because the art is tens of megabytes and the default is 1 MB.
const tar = spawnSync("tar", ["-czf", "-", ...ROOTS], { maxBuffer: 512 * 1024 * 1024 });
if (tar.status !== 0) {
  console.error(`tar failed: ${tar.stderr?.toString() ?? tar.error}`);
  process.exit(1);
}

const sealed = encryptAsset(tar.stdout, KEY);
writeFileSync(OUT, sealed);
writeFileSync(
  MANIFEST,
  JSON.stringify(
    {
      // Bumped by hand when the *layout* changes in a way an old fetch script
      // would mishandle. The digests below cover the contents.
      version: 1,
      generated: new Date().toISOString().slice(0, 10),
      roots: ROOTS,
      // Covers this one upload and no other: a fresh IV per pack means
      // encrypting identical art twice gives two different bundles. So it is
      // only meaningful once packed and uploaded together, which is why the
      // committed manifest carries `null` here until someone runs this with
      // the real key. `scripts/fetch-assets.mjs` treats it as optional.
      bundle: {
        bytes: sealed.length,
        sha256: createHash("sha256").update(sealed).digest("hex"),
      },
      files,
    },
    null,
    2
  ) + "\n"
);

const total = files.reduce((sum, f) => sum + f.bytes, 0);
console.log(`${files.length} files (${(total / 1024 / 1024).toFixed(1)} MB) → ${OUT}`);
console.log(`  ${(sealed.length / 1024 / 1024).toFixed(1)} MB encrypted, manifest in ${MANIFEST}`);
console.log(`\nUpload ${OUT} somewhere private and set ASSET_BUNDLE_URL to it.`);
console.log(`Commit ${MANIFEST}. Do NOT commit ${OUT}, assets/ or ${ART_SOURCE_DIR}/.`);
