// Plays an actual online match between two headless clients and checks that
// the guest sees the players move, not just the ball.
//
// This is the check that was missing when the desync shipped: pairing and
// message exchange both passed while the guest's court stood still.
//
//   npm run relay &
//   npm run build && npm run preview -- --port 5199 --strictPort
//   node scripts/verify-online-match.mjs
import { chromium } from "playwright-core";

const PORT = Number(process.env.PORT ?? 5199);
const base = `http://localhost:${PORT}/?q=low`;

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--no-sandbox"],
});

const errors = [];
async function client(label) {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 560 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => {
    errors.push(`${label}: ${e.message}`);
    console.log(`[${label}] pageerror`, e.message);
  });
  page.on("console", (m) => {
    if (m.type() === "error") {
      errors.push(`${label}: ${m.text()}`);
      console.log(`[${label}]`, m.text());
    }
  });
  await page.goto(base, { waitUntil: "load" });
  await page.waitForTimeout(3500);
  await page.locator("#btn-play").click();
  await page.locator("#btn-mode-online").click();
  return page;
}

const a = await client("A");
const b = await client("B");

await a.locator("#btn-online-quick").click();
await a.waitForTimeout(700);
await b.locator("#btn-online-quick").click();

// Pick deliberately different characters so a stand-in would be obvious.
for (const p of [a, b]) await p.locator("#btn-start").waitFor({ state: "visible", timeout: 20000 });
await b.locator("#btn-next").click();
await b.waitForTimeout(1200);
const picked = await Promise.all(
  [a, b].map((p) => p.locator("#item-name").textContent())
);
console.log("picked:", JSON.stringify(picked));
for (const p of [a, b]) await p.locator("#btn-start").click();
console.log("both clients started a match");

for (const p of [a, b]) await p.waitForFunction(() => "__teq" in window, null, { timeout: 240000 });
await a.waitForTimeout(6000);

const roles = await Promise.all(
  [a, b].map((p) => p.evaluate(() => window.__teq.match.netFollower === true))
);
const rosters = await Promise.all(
  [a, b].map((p) =>
    p.evaluate(() => ({
      self: window.__teq.match.chars.player.def.id,
      opp: window.__teq.match.chars.ai.def.id,
    }))
  )
);
console.log("A sees:", JSON.stringify(rosters[0]), " B sees:", JSON.stringify(rosters[1]));
const guest = roles[0] ? a : b;
const host = roles[0] ? b : a;
console.log("guest is", roles[0] ? "A" : "B");

/** Sample both characters and the ball on a page over `ms`. */
async function sample(page, ms) {
  return page.evaluate(async (duration) => {
    const m = window.__teq.match;
    const read = () => ({
      self: [m.chars.player.position.x, m.chars.player.position.z],
      opp: [m.chars.ai.position.x, m.chars.ai.position.z],
      ball: [m.ball.state.pos.x, m.ball.state.pos.z],
    });
    const first = read();
    const spread = { self: 0, opp: 0, ball: 0 };
    // Position moving is not the same as the character being animated: a
    // player sliding in an idle pose passes a position check and still looks
    // broken. Track the locomotion clip and any action clip separately.
    const locos = new Set();
    const clips = new Set();
    const t0 = Date.now();
    while (Date.now() - t0 < duration) {
      await new Promise((r) => setTimeout(r, 50));
      const now = read();
      for (const k of ["self", "opp", "ball"]) {
        spread[k] = Math.max(
          spread[k],
          Math.hypot(now[k][0] - first[k][0], now[k][1] - first[k][1])
        );
      }
      for (const side of ["player", "ai"]) {
        const c = m.chars[side];
        if (c.currentLoco) locos.add(side + ":" + c.currentLoco);
        if (c.currentActionClip) clips.add(side + ":" + c.currentActionClip);
      }
    }
    return {
      spread,
      follower: m.netFollower === true,
      locos: [...locos],
      clips: [...clips],
    };
  }, ms);
}

// Drive both players so there is real movement to observe.
const drive = async (page) => {
  for (let i = 0; i < 30; i++) {
    await page.keyboard.down("KeyA");
    await page.waitForTimeout(120);
    await page.keyboard.up("KeyA");
    await page.keyboard.down("KeyD");
    await page.waitForTimeout(120);
    await page.keyboard.up("KeyD");
    await page.keyboard.press("Space");
  }
};

const [guestSample, hostSample] = await Promise.all([
  sample(guest, 8000),
  sample(host, 8000),
  drive(host),
  drive(guest),
]);

console.log("host  spread:", JSON.stringify(hostSample.spread));
console.log("guest spread:", JSON.stringify(guestSample.spread));
console.log("host  locomotion:", JSON.stringify(hostSample.locos));
console.log("guest locomotion:", JSON.stringify(guestSample.locos));
console.log("host  action clips:", JSON.stringify(hostSample.clips));
console.log("guest action clips:", JSON.stringify(guestSample.clips));

// Input latency, reported but deliberately not asserted.
//
// A frame under software rendering takes hundreds of milliseconds, and across
// runs this has read anywhere from 297 to 578 ms on the same code — a spread
// far wider than the network delay it is meant to detect. No threshold placed
// here could distinguish prediction working from prediction absent, so making
// it a gate would only produce failures that mean nothing and passes that
// prove nothing.
//
// The prediction maths is covered exactly by tests/reconcile.test.ts. Whether
// it feels responsive is a question for a real device.
async function inputLatency(page) {
  await page.evaluate(() => {
    const m = window.__teq.match;
    window.__lat = { start: m.chars.player.position.z, t0: performance.now(), moved: null };
  });
  await page.keyboard.down("KeyA");
  const moved = await page
    .waitForFunction(
      () => {
        const m = window.__teq.match;
        if (Math.abs(m.chars.player.position.z - window.__lat.start) > 0.03) {
          window.__lat.moved = performance.now() - window.__lat.t0;
          return true;
        }
        return false;
      },
      null,
      { timeout: 3000 }
    )
    .then(() => page.evaluate(() => window.__lat.moved))
    .catch(() => null);
  await page.keyboard.up("KeyA");
  return moved;
}

const guestLatency = await inputLatency(guest);
const hostLatency = await inputLatency(host);
console.log("host  input latency:", hostLatency, "ms");
console.log("guest input latency:", guestLatency, "ms");

await guest.screenshot({ path: "/tmp/online-guest.png" });
await browser.close();

const MOVED = 0.05; // metres; anything above this is real motion
const checks = [
  ["guest is a follower", guestSample.follower],
  ["host is not a follower", !hostSample.follower],
  ["host sees its own player move", hostSample.spread.self > MOVED],
  ["host sees the opponent move", hostSample.spread.opp > MOVED],
  ["guest sees its own player move", guestSample.spread.self > MOVED],
  ["guest sees the opponent move", guestSample.spread.opp > MOVED],
  ["guest sees the ball move", guestSample.spread.ball > MOVED],
  // The checks that would have caught this round's bug: moving is not
  // animating, and a guest that runs no rules never starts a clip by itself.
  ["guest animates a run, not a slide", guestSample.locos.some((l) => l !== "player:Idle" && l !== "ai:Idle")],
  ["guest plays action clips", guestSample.clips.length > 0],
  // Only that the controls do something at all — the timing is diagnostic.
  ["guest input reaches its own character", guestLatency !== null],
  // Each peer must be looking at the character the other actually chose, not
  // a stand-in picked locally.
  ["players chose different characters", picked[0] !== picked[1]],
  ["A's opponent is who B picked", rosters[0].opp === rosters[1].self],
  ["B's opponent is who A picked", rosters[1].opp === rosters[0].self],
  ["no page errors", errors.length === 0],
];
for (const [name, ok] of checks) console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
const passed = checks.every(([, ok]) => ok);
console.log(passed ? "online match verified" : "online match FAILED");
if (errors.length) console.log(errors.slice(0, 5));
process.exit(passed ? 0 : 1);
