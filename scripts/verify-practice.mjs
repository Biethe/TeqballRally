// Checks the coached lesson, in a real browser.
//
// The first launch is the one screen every player sees and the one nothing
// else covers: it has no menu to drive it, so a unit test cannot reach it and
// a layout capture cannot tell whether it started by itself. What this holds
// is the whole contract of practice — that it opens unasked, that it teaches
// without the assistance a real match gives, that nothing about it is scored,
// and that it never happens twice.
//
// Usage:
//   npm run build
//   npm run preview -- --port 5199 --strictPort
//   node scripts/verify-practice.mjs
//
// Set CHROMIUM_PATH if playwright-core cannot find a browser on its own.
import { chromium } from "playwright-core";
const fails = [];
const check = (ok, what) => { console.log(`${ok ? "  ok  " : " FAIL "} ${what}`); if (!ok) fails.push(what); };
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args:["--use-gl=angle","--use-angle=swiftshader","--no-sandbox"] });
const ctx = await b.newContext({ viewport:{width:390,height:780}, deviceScaleFactor:2, hasTouch:true, isMobile:true });
const p = await ctx.newPage();
p.on("pageerror", (e) => fails.push("page error: " + e.message));

console.log("\nfirst launch goes straight into the lesson");
await p.goto("http://localhost:5199/?q=medium&intro=0", { waitUntil:"load" });
// No pref stored yet: this is a first launch.
await p.waitForFunction(() => Boolean(window.__teq?.match), null, { timeout: 120000 }).catch(()=>{});
check(await p.evaluate(() => Boolean(window.__teq?.match)), "a match started without anything being pressed");
check(await p.evaluate(() => window.__teq.match.practice === true), "and it is the practice match");
check(
  await p.evaluate(() => window.__teq.match.autoFirstReception === false),
  "practice gives no automatic reception"
);
check(
  await p.evaluate(() => document.getElementById("score")?.classList.contains("hidden") === true),
  "and shows no scoreboard"
);
const title = await p.evaluate(() => document.getElementById("title-screen")?.classList.contains("hidden"));
check(title !== false, "the title screen was never shown");

console.log("\nthe lesson coaches, and scoring stays off");
const coached = await p.waitForFunction(
  () => Boolean(document.querySelector("#training-pause:not(.hidden)")) ||
        Boolean(document.querySelector("#practice-panel:not(.hidden)")),
  null, { timeout: 120000 }
).then(()=>true).catch(()=>false);
check(coached, "the coach put something on screen");
const scored = await p.evaluate(() => {
  const m = window.__teq.match;
  m.score = { player: 2, ai: 1 };
  m.finishPoint?.();
  return { p: m.score.player, a: m.score.ai, sets: m.sets };
});
check(scored.sets.player === 0 && scored.sets.ai === 0, "a finished point never wins a set in practice");

console.log("\nonce it is done, a normal launch shows the title screen");
await p.evaluate(() => {
  const raw = JSON.parse(localStorage.getItem("teqopen.prefs") ?? "{}");
  localStorage.setItem("teqopen.prefs", JSON.stringify({ ...raw, coached: true }));
});
await p.goto("http://localhost:5199/?q=medium&intro=0", { waitUntil:"load" });
await p.waitForTimeout(6000);
check(
  await p.evaluate(() => document.getElementById("title-screen")?.classList.contains("hidden") === false),
  "the title screen is back"
);
await b.close();
if (fails.length) { console.log(`\n${fails.length} failed:`); for (const f of fails) console.log(" - " + f); process.exit(1); }
console.log("\nall good");
