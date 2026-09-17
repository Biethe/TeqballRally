// Drives scripts/bake-crowd.html in a browser and writes the baked textures to
// assets/models/Crowd/*.vat. Run against a dev server:
//
//   npm run dev -- --port 5178 --strictPort
//   CHROMIUM_PATH=... node scripts/bake-crowd.mjs
import { chromium } from "playwright-core";
import { writeFileSync } from "node:fs";

const PORT = Number(process.env.PORT ?? 5178);
const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ["--no-sandbox", "--no-proxy-server", "--use-gl=angle", "--use-angle=swiftshader"],
});
const page = await browser.newPage();
page.on("console", (m) => console.log(" ", m.text()));
page.on("pageerror", (e) => console.log("[error]", e.message));
await page.goto(`http://localhost:${PORT}/scripts/bake-crowd.html?bind=${process.env.BIND ?? ""}`, { waitUntil: "load" });
// Baking drives one rendered frame per baked frame, which is slow under
// software rendering; it is a one-off, so simply wait it out.
await page.waitForFunction(() => window.__bake, null, { timeout: 900000 });
const baked = await page.evaluate(() => window.__bake);

for (const [file, { width, height, data }] of Object.entries(baked)) {
  const bytes = Buffer.from(data, "base64");
  // A tiny header keeps the runtime from having to know the bone count.
  const header = Buffer.alloc(8);
  header.writeUInt32LE(width, 0);
  header.writeUInt32LE(height, 4);
  const out = `assets/models/Crowd/${file.replace(/\.glb$/, "")}.vat`;
  writeFileSync(out, Buffer.concat([header, bytes]));
  console.log(`wrote ${out}: ${width}x${height}, ${bytes.length} bytes`);
}
await browser.close();
