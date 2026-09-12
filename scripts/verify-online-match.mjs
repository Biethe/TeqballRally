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
import { asReturningPlayer, withFullRoster } from "./returning-player.mjs";

const PORT = Number(process.env.PORT ?? 5199);
const base = `http://localhost:${PORT}/?q=low&intro=0`;

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--no-sandbox"],
});

const errors = [];
/**
 * One client, in a window of its own shape.
 *
 * The two are deliberately different. Portrait and landscape are not two skins
 * over one control scheme, they are two schemes — tap and swipe against stick
 * and buttons — and the host has to read the seat it is given rather than the
 * one it is playing itself. Running both clients in a landscape window is how
 * a guest on an upright phone came to be read as a stick for a whole release.
 */
async function client(label, viewport = { width: 900, height: 560 }) {
  const ctx = await browser.newContext({ viewport, hasTouch: true });
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
  // `?intro=0` only skips the opening animation. A fresh context is a first
  // launch, and a first launch goes straight into the coached lesson with no
  // title screen behind it — so without this the run dies on an invisible
  // PLAY button, which is where it died once the lesson landed.
  await asReturningPlayer(page);
  // The two clients have to be able to pick different characters, and the
  // roster is earned: a fresh profile owns only the first one.
  await withFullRoster(page);
  // Two software-rendered contexts loading a Babylon bundle between them can
  // take well past the default half-minute on a laptop; a timeout here reads
  // as "online is broken" when the only thing that is slow is the renderer.
  page.setDefaultNavigationTimeout(180_000);
  await page.goto(base, { waitUntil: "load" });
  await page.waitForTimeout(3500);
  await page.locator("#btn-play").click();
  await page.locator("#btn-mode-online").click();
  return page;
}

const a = await client("A");
// The joining seat, held upright — the half of online play no run ever saw.
const b = await client("B", { width: 412, height: 892 });

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
    // Which phases the match actually passed through. A run that never leaves
    // the serve says nothing about play, and without this it looks identical
    // to a run where everything was tried and nothing worked.
    const phases = new Set();
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
      phases.add(m.netFollower ? m.state : m.state);
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
      phases: [...phases],
      serveOwner: m.serveOwner,
    };
  }, ms);
}

// Drive both players so there is real movement to observe.
//
// Each seat is driven through the scheme its own window actually offers. A
// portrait client has no stick and no buttons: its keys do nothing the wire
// can carry, so driving it that way would report a motionless guest whatever
// the netcode was doing.
const driveKeys = async (page) => {
  for (let i = 0; i < 70; i++) {
    await page.keyboard.down("KeyA");
    await page.waitForTimeout(120);
    await page.keyboard.up("KeyA");
    await page.keyboard.down("KeyD");
    await page.waitForTimeout(120);
    await page.keyboard.up("KeyD");
    await page.keyboard.press("Space");
  }
};

/** A press short enough to stay a placement tap. */
const tap = async (page, x, y) => {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.waitForTimeout(60);
  await page.mouse.up();
};

/** A directional drag, delivered fast enough to read as a swipe. */
const swipe = async (page, x, y, dx, dy) => {
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 4; i++) {
    await page.mouse.move(x + (dx * i) / 4, y + (dy * i) / 4);
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
};

/**
 * Gestures need room to breathe here. A frame under software rendering takes
 * hundreds of milliseconds, so a tight loop of taps and swipes delivers a
 * dozen gestures into one frame and the game sees almost none of them.
 */
const driveTouch = async (page) => {
  const { width, height } = page.viewportSize();
  for (let i = 0; i < 24; i++) {
    await tap(page, width * (i % 2 ? 0.3 : 0.7), height * 0.78);
    await page.waitForTimeout(350);
    await swipe(page, width * 0.5, height * 0.72, 0, -160);
    await page.waitForTimeout(450);
  }
};

const isPortrait = (page) => page.viewportSize().height > page.viewportSize().width;

/**
 * Wait for the gesture scheme to actually be live before driving by gesture.
 *
 * Under software rendering the scheme has been seen to take a while to settle
 * — `verify-portrait.mjs` waits on the same flag — and driving an upright
 * client before it does reports a motionless guest whatever the netcode is up
 * to, because taps and swipes have nowhere to go yet.
 */
const awaitScheme = async (page) => {
  if (!isPortrait(page)) return true;
  return page
    .waitForFunction(() => window.__teq?.match?.tapSteering === true, null, { timeout: 120000 })
    .then(() => true)
    .catch(() => false);
};

const drive = (page) => (isPortrait(page) ? driveTouch(page) : driveKeys(page));

/**
 * The most touches the joining seat takes in one possession, watched on the
 * host, which is the only peer that knows.
 *
 * Reported, deliberately not asserted. The bug worth watching for is real: the
 * first touch of a possession is automatic and needs no input, so a guest
 * whose every press was being lost still looked like it was playing — it
 * received, and then the ball fell. Anything past one is a press that actually
 * arrived.
 *
 * But two software-rendered clients flailing at the court do not reliably
 * produce a rally at all — runs here have ended with the serve crossing and
 * neither player near it — so a threshold would fail for reasons that have
 * nothing to do with the netcode. The guarantee is pinned exactly instead in
 * `tests/follower.test.ts`, which drives a whole possession over a simulated
 * wire and fails without the fix. A zero here is worth a second run; a number
 * above one is proof the press path is live end to end.
 */
async function guestTouches(page, ms) {
  return page.evaluate(async (duration) => {
    const m = window.__teq.match;
    let best = 0;
    const t0 = Date.now();
    while (Date.now() - t0 < duration) {
      await new Promise((r) => setTimeout(r, 30));
      if (m.strikeableSide === "ai") best = Math.max(best, m.touchCount);
    }
    return best;
  }, ms);
}

const schemeLive = await Promise.all([awaitScheme(a), awaitScheme(b)]);
console.log("gesture scheme live:", JSON.stringify(schemeLive));

const [guestSample, hostSample, , , guestPossession] = await Promise.all([
  sample(guest, 20000),
  sample(host, 20000),
  drive(host),
  drive(guest),
  guestTouches(host, 20000),
]);
console.log("guest touches in a possession:", guestPossession);

console.log("host  spread:", JSON.stringify(hostSample.spread));
console.log("guest spread:", JSON.stringify(guestSample.spread));
console.log("host  locomotion:", JSON.stringify(hostSample.locos));
console.log("guest locomotion:", JSON.stringify(guestSample.locos));
console.log("host  phases:", JSON.stringify(hostSample.phases), "serve:", hostSample.serveOwner);
console.log("guest phases:", JSON.stringify(guestSample.phases), "serve:", guestSample.serveOwner);
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
  // Ask through whichever control this window actually has.
  const { width, height } = page.viewportSize();
  if (isPortrait(page)) await tap(page, width * 0.25, height * 0.8);
  else await page.keyboard.down("KeyA");
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
  if (!isPortrait(page)) await page.keyboard.up("KeyA");
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
  ["both clients reached their own control scheme", schemeLive.every(Boolean)],
  ["no page errors", errors.length === 0],
];
for (const [name, ok] of checks) console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
const passed = checks.every(([, ok]) => ok);
console.log(passed ? "online match verified" : "online match FAILED");
if (errors.length) console.log(errors.slice(0, 5));
process.exit(passed ? 0 : 1);
