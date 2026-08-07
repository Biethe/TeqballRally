// Dev helper: lets the match run headless (CPU vs idle player) and logs state.
// Usage: node scripts/simulate.mjs [seconds]
import { chromium } from "playwright-core";

// Set CHROMIUM_PATH if playwright-core cannot find a browser on its own.
const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--no-sandbox"],
});
// Viewport must be big enough for the select screen's PLAY button to be on-screen.
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
page.on("console", (m) => { if (m.type() === "error") console.log("[console]", m.text()); });

await page.goto("http://localhost:5199/?ts=10&light=1&intro=0", { waitUntil: "load" });
await page.waitForTimeout(3000);
await page.locator("#btn-play").click();
// Mode flow: friendly match at normal difficulty.
await page.locator("#btn-mode-friendly").click();
await page.locator("#btn-diff-normal").click();
// Model-viewer select screen: confirm the default player + ball.
await page.locator("#btn-start").click();
await page.waitForFunction(() => "__teq" in window, null, { timeout: 180000 });
console.log("match started");

const secs = Number(process.argv[2] ?? 30);
let lastState = "";
for (let i = 0; i < secs; i++) {
  await page.waitForTimeout(1000);
  // Strike/serve attempt every tick — emulates a button-mashing player.
  await page.keyboard.press("Space");
  const s = await page.evaluate(() => {
    const t = window.__teq;
    const m = t.match;
    const b = t.ball.state;
    const fps = Math.round(m ? (t.engine.getFps()) : 0);
    return (
      `state=${m.state} score=${m.score.player}:${m.score.ai} serve=${m.serveOwner} ` +
      `last=${m.lastHitter} strk=${m.strikeableSide} ball=(${b.pos.x.toFixed(1)},${b.pos.y.toFixed(1)},${b.pos.z.toFixed(1)}) fps=${fps}`
    );
  });
  if (s !== lastState) console.log(`[${i}s]`, s);
  lastState = s;
}
await page.screenshot({ path: "/tmp/sim-final.png" });
await browser.close();
console.log("done");
