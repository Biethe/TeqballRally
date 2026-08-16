// Proves the only thing the game sells is actually gated.
//
// The gate is three separate claims, and each one fails silently on its own: a
// locked venue that still plays, a chip that lights up on a purchase nobody
// completed, and a restore path that a store reviewer has to find without
// buying anything first. Unit tests cover the rules; this covers the screens
// they are wired to.
//
//   npm run build && npm run preview -- --port 5199 --strictPort
//   node scripts/verify-purchase-gate.mjs
import { chromium } from "playwright-core";
import { asReturningPlayer } from "./returning-player.mjs";

const PORT = Number(process.env.PORT ?? 5199);

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--no-sandbox"],
});
// The A20e, upright: the device this is tested on and the tighter of its two
// orientations, so a row that does not fit shows up here first.
const page = await browser.newPage({ viewport: { width: 360, height: 760 } });
// A first launch goes into the coached lesson and never shows a title screen,
// so the run has to be a second launch to reach the picker at all.
await asReturningPlayer(page);

const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`console: ${m.text()}`);
});

await page.goto(`http://localhost:${PORT}/?q=low&intro=0`, { waitUntil: "load" });
await page.waitForTimeout(2500);

// ---------------------------------------------------------------- the picker
//
// Venues live on their own tab of the picker now — the chip strip this file
// used to drive is gone. The gate shows as PLAY turning into UNLOCK while the
// locked venue is browsed, and pressing it is what opens the paywall (or, in a
// browser with no store, the notice standing in for it).

await page.locator("#btn-play").click();
await page.locator("#btn-mode-friendly").click();
await page.locator("#btn-diff-normal").click();
await page.waitForTimeout(2500);
await page.locator('.tab-btn[data-tab="venue"]').click();
await page.waitForTimeout(600);

// The tab opens on whatever venue is actually built behind the screen, which
// for a new install must be a free court — never the one it cannot play.
const openedOn = await page.locator("#item-name").textContent();
const openedFree = openedOn !== "THE COLISEUM";
const openedUnlocked = await page.locator("#item-lock").isHidden();

/** Browse the carousel until the named venue is the one on stage. */
const browseTo = async (label) => {
  for (let i = 0; i < 6; i++) {
    if ((await page.locator("#item-name").textContent()) === label) return true;
    await page.locator("#btn-next").click();
    await page.waitForTimeout(400);
  }
  return false;
};

await browseTo("THE COLISEUM");
const gymLocked =
  (await page.locator("#item-lock").isVisible()) &&
  (await page.locator("#btn-start").evaluate((el) => el.classList.contains("selling")));

// Pressing UNLOCK in a browser: there is no store, so the game says so and
// nothing is committed. The equivalent press in the app opens the paywall.
await page.locator("#btn-start").click();
await page.waitForTimeout(800);
const noticeShown = await page
  .locator(".pause-card")
  .isVisible()
  .catch(() => false);
await page.locator(".pause-actions .big-btn").first().click();
await page.waitForTimeout(300);
const gymStayedOff = await page
  .locator("#btn-start")
  .evaluate((el) => el.classList.contains("selling"));

// A free venue is unaffected by any of this: browsing to it takes the offer
// off PLAY, and pressing PLAY commits it and starts the match.
await browseTo("THE BASELINE");
const freeLocked = await page.locator("#item-lock").isVisible();
const freeSells = await page
  .locator("#btn-start")
  .evaluate((el) => el.classList.contains("selling"));
await page.locator("#btn-start").click();
await page.waitForTimeout(2500);
const freeSwitched = await page.evaluate(
  () =>
    !document.getElementById("loading-screen")?.classList.contains("hidden") ||
    "__teq" in window
);

// -------------------------------------------------------------- the settings

await page.goto(`http://localhost:${PORT}/?q=low&intro=0`, { waitUntil: "load" });
await page.waitForTimeout(2500);
await page.locator("#btn-title-settings").click();
await page.locator("#btn-set-pro").click();
await page.waitForTimeout(400);

const rowIds = await page.evaluate(() =>
  [...document.querySelectorAll(".setting-row")].map((el) =>
    el.querySelector(".setting-label")?.textContent
  )
);
const restoreVisible = await page
  .locator(".setting-row", { hasText: "Restore purchases" })
  .isVisible();
// Reachable without buying anything and without being a member already: the
// case a reviewer checks, and the only way back for somebody who reinstalled.
await page.locator(".setting-action").last().click();
await page.waitForTimeout(600);
const restoreAnswered = await page
  .locator(".pause-card")
  .isVisible()
  .catch(() => false);

// Nothing may be drawn off the edge of a 360-wide phone.
const overflow = await page.evaluate(() =>
  [...document.querySelectorAll(".setting-row")]
    .map((el) => el.getBoundingClientRect())
    .filter((r) => r.right > window.innerWidth + 1 || r.left < -1).length
);

await browser.close();

const checks = [
  ["the sports hall is locked, and PLAY offers it", gymLocked],
  ["an outdoor court is not", !freeLocked && !freeSells],
  ["a new install opens on a free court", openedFree && openedUnlocked],
  ["pressing UNLOCK answers", noticeShown],
  ["and commits nothing", gymStayedOff],
  ["a free venue still plays", freeSwitched],
  ["settings has a membership screen", rowIds.length === 3],
  ["restore is reachable without buying", restoreVisible],
  ["and says what it found", restoreAnswered],
  ["nothing overflows a 360px phone", overflow === 0],
  ["no page errors", errors.length === 0],
];
for (const [name, ok] of checks) console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
if (errors.length) for (const e of errors) console.log(`     ${e}`);

const passed = checks.every(([, ok]) => ok);
console.log(passed ? "purchase gate verified" : "purchase gate verification FAILED");
process.exit(passed ? 0 : 1);
