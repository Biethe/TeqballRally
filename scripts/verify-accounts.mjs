// Checks that the game and the server can actually talk to each other.
//
// `tests/backend.test.ts` drives the server over real HTTP, and
// `tests/accounts.test.ts` checks the rules behind it — but neither of them is
// a browser. The things that only break in one are exactly the things this
// catches: a cross-origin reply the page is not allowed to read, a base URL
// derived wrongly, a form that never reaches `fetch`.
//
// Usage:
//   npm run build
//   npm run relay                                   # port 8787
//   npm run preview -- --port 5199 --strictPort
//   node scripts/verify-accounts.mjs
//
// Set CHROMIUM_PATH if playwright-core cannot find a browser on its own.
import { chromium } from "playwright-core";

const PORT = Number(process.env.PORT ?? 5199);
const RELAY = Number(process.env.RELAY_PORT ?? 8787);
const BASE = `http://localhost:${PORT}/`;

const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}`);
  if (!ok) failures.push(what);
};

// A name nobody else has taken, since the store outlives the run.
const NAME = `Probe ${Math.random().toString(36).slice(2, 7)}`;

const health = await fetch(`http://localhost:${RELAY}/healthz`).then(
  (r) => r.json(),
  () => null
);
if (!health?.ok) {
  console.error(`no server on :${RELAY} — run: npm run relay`);
  process.exit(1);
}

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--no-sandbox", "--no-proxy-server"],
});
const page = await browser.newPage({ viewport: { width: 390, height: 780 }, hasTouch: true });
page.on("pageerror", (e) => failures.push(`page error: ${e.message}`));

console.log("\nsigning up from the game");
await page.goto(`${BASE}?q=medium&intro=0`, { waitUntil: "load" });
await page.waitForTimeout(3000);

await page.locator("#btn-title-profile").click();
await page.waitForTimeout(600);
check(await page.locator("#profile-name").isVisible(), "the profile screen offers a name");

// The client's own validation answers before any request is made.
await page.locator("#profile-name").fill("x");
await page.locator("#btn-profile-create").click();
await page.waitForTimeout(400);
const shortMsg = await page.locator(".account-message").textContent();
check(Boolean(shortMsg?.trim()), `a name that is too short is refused locally (${shortMsg?.trim()})`);

await page.locator("#profile-name").fill(NAME);
await page.locator("#btn-profile-create").click();

const code = await page
  .waitForFunction(
    () => document.querySelector(".account-code-value")?.textContent?.trim() || null,
    null,
    { timeout: 20000, polling: 250 }
  )
  .then((h) => h.jsonValue())
  .catch(() => null);
check(Boolean(code), `the server issued a player code (${code})`);
check(/^[0-9A-HJKMNP-TV-Z]{8}$/.test(code ?? ""), "and it is a code a person could read out");

const stored = await page.evaluate(() => localStorage.getItem("teqopen.identity"));
check(Boolean(stored && JSON.parse(stored).token), "the device kept the token");

console.log("\nthe leaderboard");
await page.locator("#btn-profile-board").click();
const rows = await page
  .waitForFunction(() => document.querySelectorAll(".board-row").length, null, {
    timeout: 20000,
    polling: 250,
  })
  .then((h) => h.jsonValue())
  .catch(() => 0);
check(rows > 0, `the board came back with rows (${rows})`);
check(
  (await page.locator(".board-row.me").count()) > 0,
  "and the player can see themselves on it"
);

console.log("\nthe name reaches the title screen");
await page.locator("#board-screen .select-back").click();
await page.waitForTimeout(400);
await page.locator("#profile-screen .select-back").click();
await page.waitForTimeout(600);
const chip = await page.locator("#btn-title-profile").textContent();
check(chip?.trim() === NAME, `the profile chip wears the player's name (${chip?.trim()})`);

await browser.close();

if (failures.length === 0) {
  console.log("\nall good");
} else {
  console.log(`\n${failures.length} failed:`);
  for (const f of failures) console.log(` - ${f}`);
  process.exit(1);
}
