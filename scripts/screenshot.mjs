// Dev helper: drives the game in headless Chromium and saves screenshots.
// Usage: node scripts/screenshot.mjs [secondsInMatch]
import { chromium } from "playwright-core";

// Set CHROMIUM_PATH if playwright-core cannot find a browser on its own.
const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning") console.log("[console]", m.type(), m.text());
});
page.on("pageerror", (e) => console.log("[pageerror]", e.message));

await page.goto("http://localhost:5199/?intro=0", { waitUntil: "load" });
await page.waitForTimeout(4000);
await page.screenshot({ path: "/tmp/shot-title.png" });

// Title -> play
const play = page.locator("#btn-play");
if (await play.isVisible().catch(() => false)) {
  await play.click();
  // Mode flow: friendly match at normal difficulty.
  await page.locator("#btn-mode-friendly").click();
  await page.locator("#btn-diff-normal").click();
  // Model viewer: wait for the first character to load, then browse and shoot.
  await page.waitForTimeout(20000);
  await page.screenshot({ path: "/tmp/shot-select-player.png" });
  await page.locator('.tab-btn[data-tab="ball"]').click();
  await page.waitForTimeout(12000);
  await page.screenshot({ path: "/tmp/shot-select-ball.png" });
  await page.locator("#btn-start").click();
  // Wait for characters to load
  await page.waitForTimeout(30000);
  await page.screenshot({ path: "/tmp/shot-match-0.png" });
  // Serve if it's ours
  await page.keyboard.press("Space");
  const secs = Number(process.argv[2] ?? 8);
  for (let i = 1; i <= secs; i++) {
    await page.waitForTimeout(1000);
    if (i % 2 === 0) await page.keyboard.press("Space");
    await page.screenshot({ path: `/tmp/shot-match-${i}.png` });
  }
  const state = await page.evaluate(() => document.querySelector("#score")?.textContent);
  console.log("score:", state);
}
await browser.close();
console.log("done");
