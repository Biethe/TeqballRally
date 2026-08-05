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

for (const p of [a, b]) {
  await p.locator("#btn-start").waitFor({ state: "visible", timeout: 20000 });
  await p.locator("#btn-start").click();
}
console.log("both clients started a match");

for (const p of [a, b]) await p.waitForFunction(() => "__teq" in window, null, { timeout: 240000 });
await a.waitForTimeout(6000);

const roles = await Promise.all(
  [a, b].map((p) => p.evaluate(() => window.__teq.match.netFollower === true))
);
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
  ["no page errors", errors.length === 0],
];
for (const [name, ok] of checks) console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
const passed = checks.every(([, ok]) => ok);
console.log(passed ? "online match verified" : "online match FAILED");
if (errors.length) console.log(errors.slice(0, 5));
process.exit(passed ? 0 : 1);
