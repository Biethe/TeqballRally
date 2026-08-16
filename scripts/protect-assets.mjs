// Scramble the built models so a repository or an APK does not hand them over.
//
// Runs after `vite build`, over `dist/` only — the working copy in `assets/`
// is left alone so the dev server keeps serving plain files. Every `.glb`
// becomes a `.teq` that no 3D tool will open, and the original is deleted:
// leaving it behind would make the whole exercise decorative.
//
//   VITE_PROTECTED_ASSETS=1 vite build && node scripts/protect-assets.mjs
//
// See src/protected.ts for what this does and does not achieve — the key
// ships inside the bundle, so this stops casual extraction and nothing more.
import { readdirSync, readFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { scramble, PROTECTED_EXT } from "./scramble.mjs";

const ROOT = process.argv[2] ?? "dist/models";
const KEY = process.env.VITE_ASSET_KEY ?? "teqrallly-default-key";
const EXT = PROTECTED_EXT;

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}

let count = 0;
let bytes = 0;
for (const path of walk(ROOT)) {
  if (!path.endsWith(".glb")) continue;
  // Keyed on the bare filename, which is what the runtime knows it by.
  const name = path.slice(path.lastIndexOf("/") + 1);
  const data = scramble(new Uint8Array(readFileSync(path)), KEY, name);
  writeFileSync(path + EXT, data);
  rmSync(path);
  count++;
  bytes += data.length;
  console.log(`  ${name} → ${name}${EXT}`);
}

// A build that silently protected nothing is a build that ships the models in
// the open, and it looks exactly like a successful run.
if (count === 0) {
  console.error(`No .glb files under ${ROOT} — nothing was protected.`);
  process.exit(1);
}
console.log(`\n${count} models scrambled (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
