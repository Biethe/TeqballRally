// Fetch the art this repository deliberately does not contain.
//
//   ASSET_BUNDLE_URL=… ASSET_BUNDLE_KEY=… node scripts/fetch-assets.mjs
//
// Unpacks into `assets/` and `art-source/`, both of which are gitignored, then
// checks every file against the committed manifest. `scripts/pack-assets.mjs`
// is the other half.
//
// A clone of this repository has all the code and none of the art, which is
// the point: the models, textures, audio and video are licensed packs whose
// terms forbid redistributing them in a form other tools can open, and a
// public repository is exactly that. Without the bundle you can read
// everything, run the tests, and build with `npm run build:plain` — you just
// cannot produce a playable build, and that is deliberate rather than an
// oversight.
//
// `ASSET_BUNDLE_TOKEN` is sent as a bearer token when the storage needs one.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decryptAsset, ART_SOURCE_DIR } from "./scramble.mjs";

const URL_ = process.env.ASSET_BUNDLE_URL;
const KEY = process.env.ASSET_BUNDLE_KEY;
const TOKEN = process.env.ASSET_BUNDLE_TOKEN;
const MANIFEST = "assets.manifest.json";

if (!URL_ || !KEY) {
  console.error(
    "ASSET_BUNDLE_URL and ASSET_BUNDLE_KEY must both be set.\n\n" +
      "This repository does not contain the art — see the note at the top of\n" +
      "this file. To work on the code without it: `npm run check` and\n" +
      "`npm run build:plain` both run fine against an empty assets/."
  );
  process.exit(1);
}

if (!existsSync(MANIFEST)) {
  console.error(`${MANIFEST} is missing — cannot verify a bundle against nothing.`);
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));

console.log(`Fetching ${manifest.files.length} files…`);
const response = await fetch(URL_, {
  headers: {
    // A GitHub release asset is the one host that needs asking. Its API URL
    // returns *JSON metadata* by default and the actual bytes only with this
    // header — without it the download "succeeds" and hands back a few hundred
    // bytes of JSON, which then fails as a corrupt bundle rather than as the
    // wrong Accept header. Harmless everywhere else.
    accept: "application/octet-stream",
    ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
  },
  redirect: "follow",
});
if (!response.ok) {
  console.error(`${response.status} ${response.statusText} fetching the art bundle.`);
  if (response.status === 404 && !TOKEN) {
    console.error("A private URL returns 404 rather than 403 when unauthenticated — set ASSET_BUNDLE_TOKEN.");
  }
  process.exit(1);
}
const sealed = Buffer.from(await response.arrayBuffer());

// Checked before decrypting rather than after: a truncated download and a
// wrong key both fail the GCM tag, and they need different advice.
const got = createHash("sha256").update(sealed).digest("hex");
if (manifest.bundle?.sha256 && got !== manifest.bundle.sha256) {
  console.error(
    `The bundle at ASSET_BUNDLE_URL is not the one ${MANIFEST} describes.\n` +
      `  expected ${manifest.bundle.sha256}\n  got      ${got}\n` +
      "Either the upload is stale or the manifest is — re-run scripts/pack-assets.mjs."
  );
  process.exit(1);
}

let tarball;
try {
  tarball = decryptAsset(sealed, KEY);
} catch {
  console.error("The bundle would not decrypt — ASSET_BUNDLE_KEY is wrong for this upload.");
  process.exit(1);
}

// Through a temp file rather than a pipe: tar reading a 40 MB stdin through
// spawnSync is where this hung the first time.
const scratch = mkdtempSync(join(tmpdir(), "teq-art-"));
const archive = join(scratch, "art.tar.gz");
try {
  writeFileSync(archive, tarball);
  const untar = spawnSync("tar", ["-xzf", archive], { stdio: "inherit" });
  if (untar.status !== 0) {
    console.error(`tar failed to extract the bundle: ${untar.error ?? untar.status}`);
    process.exit(1);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

// The manifest exists for this. A bundle that unpacks but is missing a texture
// produces a build that looks fine until somebody picks that venue.
const missing = [];
const corrupt = [];
for (const file of manifest.files) {
  if (!existsSync(file.path)) {
    missing.push(file.path);
    continue;
  }
  const bytes = readFileSync(file.path);
  if (createHash("sha256").update(bytes).digest("hex") !== file.sha256) corrupt.push(file.path);
}

if (missing.length || corrupt.length) {
  for (const path of missing) console.error(`  missing: ${path}`);
  for (const path of corrupt) console.error(`  altered: ${path}`);
  console.error(
    `\nThe bundle does not match ${MANIFEST}. Re-run scripts/pack-assets.mjs on a\n` +
      "machine with the real art and upload the result."
  );
  process.exit(1);
}

console.log(`${manifest.files.length} files verified against ${MANIFEST}.`);
console.log(`assets/ and ${ART_SOURCE_DIR}/ are ready — both are gitignored, keep them that way.`);
