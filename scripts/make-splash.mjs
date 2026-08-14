// Rebuild the Android launch screens from the app icon.
//
// Capacitor ships its own logo on white as `drawable*/splash.png`, and the
// launch theme points straight at it — so every cold start opened on somebody
// else's mark, then cut to a dark game. These are generated instead: the real
// icon on the game's own background colour, so the launch screen dissolves
// into the first frame rather than flashing white in between.
//
// Rendered through headless Chromium because it is the image tool this machine
// already has, and because a browser is the thing that knows how to scale a
// PNG well.
//
//   node scripts/make-splash.mjs
import { chromium } from "playwright-core";
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const RES = "android/app/src/main/res";
const ICON = "store/play-listing-icon-512.png";
/** The game's own --ink, so the splash and the first frame are one colour. */
const BACKGROUND = "#071426";

/** Width and height straight out of a PNG's IHDR. */
function pngSize(file) {
  const b = readFileSync(file);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

const targets = readdirSync(RES)
  .filter((d) => d.startsWith("drawable"))
  .map((d) => join(RES, d, "splash.png"))
  .filter(existsSync)
  .map((file) => ({ file, ...pngSize(file) }));

if (targets.length === 0) throw new Error(`no splash.png under ${RES}`);

const icon = `data:image/png;base64,${readFileSync(ICON).toString("base64")}`;
const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ["--no-sandbox"],
});

for (const { file, width, height } of targets) {
  const page = await browser.newPage({ viewport: { width, height } });
  // The icon is sized off the short edge so it lands the same size in the
  // frame whichever way the phone is held, and kept well clear of the edges:
  // Android crops this image to fill, and a logo near the edge is the part
  // that gets cut.
  const size = Math.round(Math.min(width, height) * 0.42);
  await page.setContent(
    `<style>
       html,body{margin:0;height:100%;background:${BACKGROUND};}
       body{display:flex;align-items:center;justify-content:center;}
       img{width:${size}px;height:${size}px;border-radius:${Math.round(size * 0.22)}px;}
     </style>
     <img src="${icon}">`
  );
  writeFileSync(file, await page.screenshot({ type: "png" }));
  await page.close();
  console.log(`${file}  ${width}x${height}`);
}

await browser.close();
console.log(`\n${targets.length} launch screens rebuilt from ${ICON}`);
