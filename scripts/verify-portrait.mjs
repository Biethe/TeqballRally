// Checks that the game is playable with the phone held upright.
//
// Portrait has no room for a stick and two buttons, so it plays by gesture
// instead: tap to place the player, swipe to kick, hold to receive. None of
// that can be unit-tested — it only exists once a real browser has laid the
// controls out, built a camera and put a match behind them — so it is checked
// here, against the production build, the same way the menus and the opening
// clip are.
//
// Usage:
//   npm run build
//   npm run preview -- --port 5199 --strictPort
//   node scripts/verify-portrait.mjs
//
// Set CHROMIUM_PATH if playwright-core cannot find a browser on its own.
import { chromium } from "playwright-core";

const PORT = Number(process.env.PORT ?? 5199);
const BASE = `http://localhost:${PORT}/`;

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--no-sandbox", "--no-proxy-server"],
});

const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}`);
  if (!ok) failures.push(what);
};

/** Walk the menus into a live match and hand back the page. */
async function intoMatch(viewport) {
  const page = await browser.newPage({ viewport, hasTouch: true });
  page.on("pageerror", (e) => failures.push(`page error: ${e.message}`));
  await page.goto(`${BASE}?q=medium&intro=0`, { waitUntil: "load" });
  await page.waitForTimeout(3000);
  await page.locator("#btn-play").click();
  await page.locator("#btn-mode-friendly").click();
  await page.locator("#btn-diff-normal").click();
  // The select screen runs the model viewer, which downloads a character.
  await page.locator("#btn-start").click({ timeout: 120000 });
  await page.waitForFunction(() => "__teq" in window, null, { timeout: 240000 });
  await page.waitForTimeout(4000);
  return page;
}

/** The match state the assertions below are written against. */
const readMatch = (page) =>
  page.evaluate(() => {
    const m = window.__teq.match;
    const layer = document.getElementById("touch-layer");
    const joy = document.querySelector(".joy-base");
    return {
      tapSteering: m.tapSteering,
      state: m.state,
      moveTarget: m.moveTarget ? { x: m.moveTarget.x, z: m.moveTarget.z } : null,
      player: { x: m.chars.player.position.x, z: m.chars.player.position.z },
      portraitClass: layer?.classList.contains("portrait") ?? null,
      joyShown: joy ? getComputedStyle(joy).display !== "none" : null,
      hintsShown: (() => {
        const h = document.getElementById("touch-portrait-hints");
        return h ? getComputedStyle(h).display !== "none" : null;
      })(),
    };
  });

/** A press short enough to stay a placement tap. */
async function tap(page, x, y) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.waitForTimeout(60);
  await page.mouse.up();
}

/** A press long enough to become a reception, held in one place. */
async function hold(page, x, y, ms = 400) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.waitForTimeout(ms);
  await page.mouse.up();
}

/** A directional drag, delivered fast enough to read as a swipe. */
async function swipe(page, x, y, dx, dy) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 4; i++) await page.mouse.move(x + (dx * i) / 4, y + (dy * i) / 4);
  await page.mouse.up();
}

/** True once `probe` holds, without failing the run when it never does. */
const settles = (page, probe, timeout = 60000, arg = null) =>
  page.waitForFunction(probe, arg, { timeout, polling: 250 }).then(() => true).catch(() => false);

console.log("\nportrait: the screen is the controller");
{
  const page = await intoMatch({ width: 420, height: 860 });
  // The establishing camera sweep holds the loop before gameplay starts, and
  // software rendering makes that take real seconds. Waiting for the match to
  // be told about the layout is waiting for the game itself to have started.
  const live = await settles(page, () => window.__teq.match.tapSteering === true, 120000);
  check(live, "the match is told the player is placed by tapping");

  const start = await readMatch(page);
  check(start.portraitClass === true, "the touch layer switches to its portrait layout");
  check(start.joyShown === false, "the move stick is gone");
  check(start.hintsShown === true, "the gesture legend is up");

  // Who serves first is a coin toss. Re-toss it until it is the player's, so
  // the serve gesture is actually reachable from here.
  await page.evaluate(() => {
    const m = window.__teq.match;
    for (let i = 0; i < 60 && m.serveOwner !== "player"; i++) m.reset();
  });
  const ready = await settles(page, () => window.__teq.match.state === "serve_ready", 90000);
  check(ready, "the player walks up to serve");

  // A serve is the one gesture outcome that is unambiguous from outside: the
  // match leaves serve_ready only when a strike actually fired.
  await swipe(page, 210, 620, 0, -160);
  check(await settles(page, () => window.__teq.match.state !== "serve_ready", 10000), "a swipe serves");

  // Placement only means anything once the rally is live — between points the
  // match walks the players to their own spots.
  check(await settles(page, () => window.__teq.match.state === "rally", 30000), "the rally starts");

  // A held press is a reception, and must never send the player running
  // somewhere they did not ask to go. Checked first, while there is provably
  // no destination for it to be confused with.
  await hold(page, 340, 500);
  const strayed = await settles(page, () => window.__teq.match.moveTarget !== null, 4000);
  check(!strayed, "a held press is not mistaken for a placement tap");

  // Where the tap lands depends on the camera, so what is asserted is that it
  // becomes a destination and the player runs for it — not which metre.
  const before = await readMatch(page);
  await tap(page, 210, 700);
  const placed = await settles(page, () => window.__teq.match.moveTarget !== null, 12000);
  const target = (await readMatch(page)).moveTarget;
  check(placed, `a tap becomes a court destination (${JSON.stringify(target)})`);
  const walked = await settles(
    page,
    (p) => {
      const c = window.__teq.match.chars.player.position;
      return Math.hypot(c.x - p.x, c.z - p.z) > 0.25;
    },
    20000,
    before.player
  );
  check(walked, "the player runs to it");
  await page.close();
}

console.log("\nlandscape: the stick and buttons are back");
{
  const page = await intoMatch({ width: 900, height: 420 });
  await settles(page, () => window.__teq.match.state === "serve_move", 120000);
  const state = await readMatch(page);
  check(state.portraitClass === false, "the touch layer is in its landscape layout");
  check(state.joyShown === true, "the move stick is shown");
  check(state.hintsShown === false, "the gesture legend is hidden");
  check(state.tapSteering === false, "the stick steers, not taps");
  await page.close();
}

await browser.close();
if (failures.length) {
  console.log(`\n${failures.length} failed:`);
  for (const f of failures) console.log(` - ${f}`);
  process.exit(1);
}
console.log("\nall good");
