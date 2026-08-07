// Checks the opening clip's boot contract in a real browser.
//
// The clip must never be able to cost the player the game: if it plays, the
// title screen waits for it and a tap gets past it; if the device cannot decode
// it, boot carries on immediately and nothing black is ever shown.
//
// Chromium builds without proprietary codecs (Playwright's included, and CI's)
// cannot decode the shipped H.264 file, which is itself one of the cases worth
// testing. To exercise the playing path there too, pass a WebM transcode of the
// clip and it is served in the MP4's place at the network layer — same code
// path, same file name:
//
//   ffmpeg -i assets/video/intro.mp4 -c:v libvpx-vp9 -crf 40 -b:v 0 \
//     -c:a libopus /tmp/intro.webm
//
//   npm run build && npm run preview -- --port 5199 --strictPort
//   WEBM=/tmp/intro.webm node scripts/verify-intro.mjs
import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";

const PORT = Number(process.env.PORT ?? 5199);
const BASE = `http://localhost:${PORT}/`;
const WEBM = process.env.WEBM;

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ["--no-sandbox", "--no-proxy-server", "--use-gl=angle", "--use-angle=swiftshader"],
});

const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}`);
  if (!ok) failures.push(what);
};

/** A page whose intro request is answered with a decodable transcode. */
async function open(url = BASE, { decodable = true } = {}) {
  const page = await browser.newPage({ viewport: { width: 800, height: 480 } });
  page.on("pageerror", (e) => failures.push(`page error: ${e.message}`));
  if (decodable && WEBM) {
    const body = readFileSync(WEBM);
    await page.route("**/video/intro.mp4", (route) =>
      route.fulfill({ status: 200, contentType: "video/webm", body }));
  }
  await page.goto(url, { waitUntil: "domcontentloaded" });
  return page;
}

const canDecode = await (async () => {
  const page = await browser.newPage();
  await page.setContent("<video id=v></video>");
  const support = await page.evaluate(() =>
    document.querySelector("#v").canPlayType('video/mp4; codecs="avc1.42E01E"'));
  await page.close();
  return support !== "";
})();
console.log(`H.264 in this browser: ${canDecode ? "yes" : "no"}${WEBM ? " · WebM stand-in supplied" : ""}`);

if (canDecode || WEBM) {
  console.log("\nthe clip plays");
  const page = await open();
  const started = Date.now();
  await page.waitForSelector("#intro-clip:not(.hidden)", { timeout: 30000 });
  check(Date.now() - started < 5000, "appears while the scene is still building");
  const state = await page.evaluate(() => {
    const v = document.getElementById("intro-clip-video");
    return { paused: v.paused, duration: v.duration, error: v.error?.code ?? null };
  });
  check(!state.paused && !state.error, `is actually playing (${JSON.stringify(state)})`);
  check(!(await page.isVisible("#title-screen:not(.hidden)")), "holds the title screen back");
  await page.waitForSelector("#title-screen:not(.hidden)", { timeout: 30000 });
  const cleared = await page.evaluate(() => {
    const v = document.getElementById("intro-clip-video");
    return { hidden: v.closest(".screen").classList.contains("hidden"), src: v.getAttribute("src") };
  });
  check(cleared.hidden && cleared.src === null, "releases the decoder once the title is up");
  await page.close();

  console.log("\nthe clip can be skipped");
  for (const [how, act] of [
    ["the skip button", (p) => p.click("#btn-skip-intro")],
    ["a tap anywhere", (p) => p.mouse.click(400, 200)],
    ["a key", (p) => p.keyboard.press("Escape")],
  ]) {
    const p = await open();
    await p.waitForSelector("#intro-clip:not(.hidden)", { timeout: 30000 });
    const t = Date.now();
    await act(p);
    await p.waitForSelector("#title-screen:not(.hidden)", { timeout: 30000 });
    check(Date.now() - t < 3000, `${how} gets past it (${Date.now() - t} ms)`);
    await p.close();
  }
} else {
  console.log("\nskipping the playing cases: no H.264 decoder and no WEBM= stand-in");
}

console.log("\nthe clip cannot be played");
{
  const page = await open(BASE, { decodable: false });
  const started = Date.now();
  await page.waitForSelector("#title-screen:not(.hidden)", { timeout: 30000 });
  const took = Date.now() - started;
  if (canDecode) {
    check(true, `not exercised here: this browser decodes the real file (${took} ms)`);
  } else {
    check(took < 15000, `boot carries straight on (${took} ms)`);
    check(!(await page.isVisible("#intro-clip:not(.hidden)")), "never shows a black overlay");
  }
  await page.close();
}

console.log("\nthe clip is switched off");
{
  let requested = false;
  const page = await browser.newPage({ viewport: { width: 800, height: 480 } });
  page.on("request", (r) => {
    if (r.url().includes("/video/")) requested = true;
  });
  await page.goto(`${BASE}?intro=0`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#title-screen:not(.hidden)", { timeout: 30000 });
  check(!requested, "?intro=0 does not even fetch it");
  await page.close();
}

await browser.close();
if (failures.length) {
  console.log(`\n${failures.length} failed:`);
  for (const f of failures) console.log(` - ${f}`);
  process.exit(1);
}
console.log("\nall good");
