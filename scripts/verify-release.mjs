// Checks that the bundle players actually receive boots, and that it hands out
// nothing it should not.
//
// The other harnesses in here drive the game through `window.__teq*`, so they
// can only run against `npm run build:harness` — a build that still exposes
// them. That leaves the release bundle, the one on the store, as the only
// build nothing ever loaded. It is also the one the dead-code elimination
// changes most: the hooks, the free camera and every `console` call are cut
// out of it, and "cut out" and "cut too much out" look identical until a
// browser runs it.
//
// So this loads the real thing, waits for a screen, and asserts both halves:
// the game drew, and `__teq` and friends are not there to be picked up.
//
//   npm run build
//   npm run preview -- --port 5199 --strictPort
//   node scripts/verify-release.mjs
//
// Set CHROMIUM_PATH if playwright-core cannot find a browser on its own.
import { chromium } from "playwright-core";
import { asReturningPlayer } from "./returning-player.mjs";

const PORT = Number(process.env.PORT ?? 5199);

/** The handles the harnesses use. A release must not carry any of them. */
const DEV_HOOKS = ["__teq", "__teqUi", "__teqCharacters", "__viewer", "__swap", "__freecam"];

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--no-sandbox", "--no-proxy-server"],
});
const page = await browser.newPage({ viewport: { width: 1024, height: 640 } });

const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`console: ${m.text()}`);
});

const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}`);
  if (!ok) failures.push(what);
};

await asReturningPlayer(page);
await page.goto(`http://localhost:${PORT}/`, { waitUntil: "load" });
// A software renderer takes its time building the scene; the title screen is
// the first thing drawn once it has.
await page.waitForFunction(() => document.querySelector("#ui-root > *") !== null, null, {
  timeout: 300000,
});
// Long enough for the venue and the deferred loads behind the title to finish
// and throw if they are going to.
await page.waitForTimeout(8000);

const state = await page.evaluate((hooks) => ({
  drew: document.querySelector("#ui-root > *") !== null,
  // index.html's startup reporter. Present means the page caught a crash
  // before the game could say anything about it.
  fatal: document.getElementById("fatal-error")?.textContent?.slice(0, 300) ?? null,
  exposed: hooks.filter((k) => k in window),
}), DEV_HOOKS);

check(state.drew, "the release bundle draws a screen");
check(state.fatal === null, "no startup error");
if (state.fatal) console.log(state.fatal);
check(state.exposed.length === 0, `no dev hooks on window (found: ${state.exposed.join(", ") || "none"})`);
check(errors.length === 0, "no page errors");
for (const e of errors) console.log(`   ${e}`);

await browser.close();
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("release verified");
