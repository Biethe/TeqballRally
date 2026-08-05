// Smoke-tests the PRODUCTION build in a real browser: walks the menus into a
// match and asserts the .glb assets actually reached the scene. This is the
// check that catches a broken asset pipeline — a wrong loader import or a
// mis-chunked bundle still typechecks, still builds, and only fails here.
//
// Usage:
//   npm run build
//   npm run preview -- --port 5199 --strictPort
//   node scripts/verify-build.mjs
//
// Set CHROMIUM_PATH if playwright-core cannot find a browser on its own.
import { chromium } from "playwright-core";

const PORT = Number(process.env.PORT ?? 5199);
const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1024, height: 640 } });

const errors = [];
page.on("pageerror", (e) => {
  errors.push(`pageerror: ${e.message}`);
  console.log("[pageerror]", e.message);
});
page.on("console", (m) => {
  if (m.type() !== "error") return;
  errors.push(`console: ${m.text()}`);
  console.log("[console]", m.text());
});
page.on("requestfailed", (r) => {
  errors.push(`requestfailed: ${r.url()}`);
  console.log("[requestfailed]", r.url(), r.failure()?.errorText);
});

await page.goto(`http://localhost:${PORT}/?ts=10&light=1`, { waitUntil: "load" });
await page.waitForTimeout(4000);

// Title -> friendly match at normal difficulty -> select screen.
await page.locator("#btn-play").click();
await page.locator("#btn-mode-friendly").click();
await page.locator("#btn-diff-normal").click();
// The select screen runs the model viewer, which loads a character .glb.
await page.waitForTimeout(25000);
await page.locator("#btn-start").click();

await page.waitForFunction(() => "__teq" in window, null, { timeout: 240000 });
await page.waitForTimeout(8000);

const report = await page.evaluate(() => {
  const t = window.__teq;
  const scene = t.scene ?? t.engine.scenes[0];
  return {
    meshCount: scene.meshes.length,
    verticesTotal: scene.meshes.reduce((n, m) => n + (m.getTotalVertices?.() ?? 0), 0),
    skeletons: scene.skeletons.length,
    animationGroups: scene.animationGroups.length,
  };
});
console.log(JSON.stringify(report, null, 2));

await browser.close();

// Both characters bring a skeleton and their full animation set; the arena and
// table add most of the geometry. A loader failure leaves only the procedural
// court behind, which is far below every one of these floors.
const checks = [
  ["skeletons", report.skeletons >= 2],
  ["animationGroups", report.animationGroups > 20],
  ["vertices", report.verticesTotal > 50000],
  ["no page errors", errors.length === 0],
];
for (const [name, ok] of checks) console.log(`${ok ? "ok  " : "FAIL"} ${name}`);

const passed = checks.every(([, ok]) => ok);
console.log(passed ? "build verified" : "build verification FAILED");
process.exit(passed ? 0 : 1);
