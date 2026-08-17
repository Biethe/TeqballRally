// Encrypt the built assets so an APK or a deployed build does not hand them over.
//
// Runs after `vite build`, over `dist/` only — the working copy in `assets/`
// is left alone so the dev server keeps serving plain files. Every model,
// texture, venue card, sound and video becomes an AES-256-GCM `.teq` that is
// indistinguishable from noise, and the original is deleted: leaving it behind
// would make the whole exercise decorative.
//
//   VITE_PROTECTED_ASSETS=1 vite build && node scripts/protect-assets.mjs
//
// See src/protected.ts for what this does and does not achieve. The cipher is
// real; the caveat is key distribution, since a packaged game has to decrypt
// its own assets offline and so carries the key. What the key no longer
// unlocks is anything in this repository — the plaintext art is not committed.
import { readdirSync, readFileSync, writeFileSync, rmSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  encryptAsset,
  isProtectedAsset,
  PROTECTED_EXT,
  PROTECTED_DIRS,
  ART_SOURCE_DIR,
} from "./scramble.mjs";

const ROOT = process.argv[2] ?? "dist";
const KEY = process.env.VITE_ASSET_KEY;

// A release encrypted with a passphrase written in a public repository is not
// encrypted, it is base64 with extra steps. The dev fallback that used to live
// here was the value every shipped build actually used, because nothing in
// `.github/workflows/` ever set this variable.
if (!KEY) {
  console.error(
    "VITE_ASSET_KEY is not set — refusing to protect assets with a guessable key.\n" +
      "Set it to the release passphrase (Settings → Secrets and variables → Actions).\n" +
      "For a local build with no secrets, use `npm run build:plain`."
  );
  process.exit(1);
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}

// Vite copies all of `publicDir` to the root of `dist/` and offers no way to
// exclude part of it, so anything that must not ship has to be either outside
// `assets/` or deleted here. The Mixamo rigs are the first kind now
// (`art-source/`); this stays as the backstop for a working copy that predates
// the move, where `assets/source-animations/` still exists and would otherwise
// be served raw at the deployed URL.
const strays = join(ROOT, "source-animations");
if (existsSync(strays)) {
  rmSync(strays, { recursive: true, force: true });
  console.log(`  removed ${strays} (raw art belongs in ${ART_SOURCE_DIR}/, not in a build)`);
}

let count = 0;
let bytes = 0;
let skipped = 0;
for (const dir of PROTECTED_DIRS) {
  const base = join(ROOT, dir);
  if (!existsSync(base)) continue;
  for (const path of walk(base)) {
    if (path.endsWith(PROTECTED_EXT)) continue; // already done, e.g. a re-run
    if (!isProtectedAsset(path)) {
      skipped++;
      continue;
    }
    const data = encryptAsset(readFileSync(path), KEY);
    writeFileSync(path + PROTECTED_EXT, data);
    rmSync(path);
    count++;
    bytes += data.length;
  }
  console.log(`  ${dir}/`);
}

// A build that silently protected nothing is a build that ships the assets in
// the open, and it looks exactly like a successful run. This has caught the
// real case twice: an empty `dist/` from a failed Vite step, and a working
// copy where `npm run assets:fetch` had never been run.
if (count === 0) {
  console.error(
    `No protectable files under ${ROOT}/{${PROTECTED_DIRS.join(",")}} — nothing was protected.\n` +
      "If this is a fresh clone, the art is not in the repository: run `npm run assets:fetch`."
  );
  process.exit(1);
}

// Not fatal, but worth a line: a file type nobody thought about is a file type
// shipping in the clear next to the encrypted ones.
if (skipped > 0) {
  console.log(`\n${skipped} file(s) left plain — extensions outside the protected list.`);
}
console.log(`${count} assets encrypted (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
