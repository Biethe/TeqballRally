// Checks that the game is playable with the phone held upright.
//
// Portrait has no room for a stick and two buttons, so it plays by gesture
// instead: tap to place the player or aim a set-up, swipe to kick. None
// of that can be unit-tested — it only exists once a real browser has laid the
// controls out, built a camera and put a match behind them — so it is checked
// here, against the production build, the same way the menus and the opening
// clip are.
//
// The automatic first reception is checked here too. It is not a portrait rule
// — it applies to every input — but this is the harness that already has a
// live rally in front of it.
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
  // The select screen runs the model viewer, which downloads and renders a
  // character. Starting the match before that settles has been seen to leave
  // the match never arriving at all, so give it room — this browser has no GPU
  // and every one of these seconds is a software-rendered frame.
  await page.waitForTimeout(20000);
  await page.locator("#btn-start").click({ timeout: 120000 });
  await page.waitForFunction(() => "__teq" in window, null, { timeout: 300000 });
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
      touchCount: m.touchCount,
      strikeable: m.strikeableSide,
      charging: m.charging.player,
      aim: { x: m.aimSpot.player.x, z: m.aimSpot.player.z },
      markerOn: window.__teq.match.aimMarker?.isEnabled() ?? null,
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

/** A finger resting in one place, which must mean nothing at all. */
async function rest(page, x, y, ms = 700) {
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

  // A resting finger must do nothing at all — above all it must not be read
  // as a placement, which would send the player somewhere they never asked
  // to go. Checked first, while there is provably no destination to confuse.
  await rest(page, 340, 500);
  const strayed = await settles(page, () => window.__teq.match.moveTarget !== null, 4000);
  check(!strayed, "a resting finger is not mistaken for a placement tap");

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

  // Standing near an incoming ball is enough for the first touch: press
  // nothing, and the touch count moves on its own.
  //
  // The state is armed rather than waited for. Catching a live rally at the
  // moment a ball arrives beside a stationary player needs the browser to hold
  // still for a few tenths of a second, and this one renders about one frame a
  // second — the rule held every time it was actually observed, and the check
  // failed on the frames where it never got to look.
  const auto = await settles(
    page,
    () => {
      const m = window.__teq.match;
      const c = m.chars.player;
      if (m.touchCount > 0) return true;
      if (m.state !== "rally") return false;
      m.setMoveTarget(null);
      m.pendingTouch = null;
      m.bufferedPress = null;
      c.stopAction();
      m.ball.held = false;
      m.ball.state.pos.set(c.position.x + 0.5, c.position.y + c.height * 0.6, c.position.z);
      m.ball.state.vel.set(0, -1, 0);
      m.strikeableSide = "player";
      m.touchCount = 0;
      return false;
    },
    90000
  );
  check(auto, "the first reception is taken automatically");

  // One tap, two meanings. With the ball still on its way it is a shift; with
  // the ball already in the vicinity there is no time to go anywhere, so the
  // same tap says which way to set the reception up instead. Driven directly
  // rather than through a finger: both cases have to be observed inside one
  // frame, and this browser renders about one a second.
  const dual = await page.evaluate(() => {
    const m = window.__teq.match;
    const c = m.chars.player;
    const V = m.aimSpot.player.constructor;
    const point = new V(c.position.x + 2, 0.4, c.position.z + 2);
    // Both halves of the rule need the same starting state, and a rally at one
    // frame a second will not hold still on its own: a character mid-animation
    // or a queued touch would send the tap down the other branch and read as a
    // failure of the rule rather than of the timing.
    const place = (dx) => {
      m.state = "rally";
      m.pendingTouch = null;
      m.chars.player.stopAction();
      m.ball.held = false;
      m.ball.state.pos.set(c.position.x + dx, c.position.y + c.height * 0.6, c.position.z);
      m.ball.state.vel.set(0, 0, 0);
      m.strikeableSide = "player";
      m.touchCount = 0;
      m.setMoveTarget(null);
      m.receptionAim = null;
    };
    place(6); // ball far away
    m.tapAt(point);
    const far = { moved: m.moveTarget !== null, aimed: m.receptionAim !== null };
    place(0.4); // ball right there
    m.tapAt(point);
    const near = { moved: m.moveTarget !== null, aimed: m.receptionAim !== null };
    return { far, near };
  });
  check(dual.far.moved && !dual.far.aimed, "a tap with the ball still coming is a shift");
  check(dual.near.aimed && !dual.near.moved, "a tap with the ball in the vicinity aims the reception");

  // The rule has to hold for every touch of the possession, not just the first.
  // Portrait has no reception button, so if a tap on a ball that is already in
  // the vicinity does not ask for the touch, nothing does — and the tap becomes
  // a walk instead, which is how the player ends up strolling off mid-rally.
  const later = await page.evaluate(() => {
    const m = window.__teq.match;
    const c = m.chars.player;
    const V = m.aimSpot.player.constructor;
    const arm = (touches, busy) => {
      m.state = "rally";
      m.pendingTouch = null;
      m.bufferedPress = null;
      if (!busy) m.chars.player.stopAction();
      m.ball.held = false;
      m.ball.state.pos.set(c.position.x + 0.4, c.position.y + c.height * 0.6, c.position.z);
      m.ball.state.vel.set(0, 0, 0);
      m.strikeableSide = "player";
      m.touchCount = touches;
      m.setMoveTarget(null);
    };
    arm(1, false);
    m.tapAt(new V(c.position.x + 2, 0.4, c.position.z));
    const second = { asked: m.bufferedPress?.kind ?? null, moved: m.moveTarget !== null };
    // Deep and wide have to be distinguishable, or a directed set-up only ever
    // reads as left and right.
    arm(1, false);
    m.tapAt(new V(c.position.x + 2.2, 0.4, c.position.z));
    const deep = { ...m.bufferedPress };
    arm(1, false);
    m.tapAt(new V(c.position.x, 0.4, c.position.z + 2.2));
    const wide = { ...m.bufferedPress };
    return { second, deep, wide };
  });
  check(later.second.asked === "pop", "a tap on the second touch asks for the touch");
  check(!later.second.moved, "and does not also become somewhere to walk");
  check(
    Math.abs(later.deep.aimX) > Math.abs(later.deep.aimZ),
    `a tap ahead plays the ball deep (${later.deep.aimX?.toFixed?.(2)}, ${later.deep.aimZ?.toFixed?.(2)})`
  );
  check(
    Math.abs(later.wide.aimZ) > Math.abs(later.wide.aimX),
    `a tap to the side plays it wide (${later.wide.aimX?.toFixed?.(2)}, ${later.wide.aimZ?.toFixed?.(2)})`
  );

  // The reported symptom, checked directly: a tap that meant a touch must not
  // survive as a destination and release the player across the court later.
  const noStray = await page.evaluate(() => {
    const m = window.__teq.match;
    const c = m.chars.player;
    const V = m.aimSpot.player.constructor;
    m.state = "rally";
    m.strikeableSide = "player";
    m.touchCount = 1;
    m.selfSetupSpot = new V(c.position.x, 0.4, c.position.z);
    m.setMoveTarget(new V(c.position.x + 3, 0.4, c.position.z + 3));
    const idle = {
      moveX: 0,
      moveZ: 0,
      strikePressed: false,
      strikeHeld: false,
      strikePower: 0,
      popPressed: false,
      confirmPressed: false,
      isPortrait: true,
      isTouch: true,
    };
    m.update(1 / 60, idle, () => {});
    return m.moveTarget === null;
  });
  check(noStray, "a stored destination is dropped when the auto-run takes over");

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

  // Holding the kick control charges it and hands the stick to the aim marker.
  //
  // The state it needs is set directly rather than waited for. Charging is
  // only allowed while the ball is this player's and they are not already
  // mid-animation, and at one rendered frame a second that window opens and
  // shuts between polls — waiting for it made this check report a working
  // feature as broken about a third of the time.
  await page.evaluate(() => {
    const m = window.__teq.match;
    for (let i = 0; i < 60 && m.serveOwner !== "player"; i++) m.reset();
  });
  await settles(page, () => window.__teq.match.state === "serve_ready", 90000);
  await page.keyboard.press("Space"); // serve
  check(await settles(page, () => window.__teq.match.state === "rally", 40000), "a keyboard serve starts the rally");

  const before = await page.evaluate(() => {
    const m = window.__teq.match;
    const c = m.chars.player;
    m.state = "rally";
    m.pendingTouch = null;
    m.bufferedPress = null;
    c.stopAction();
    m.ball.held = false;
    m.ball.state.pos.set(c.position.x + 1, c.position.y + c.height * 0.6, c.position.z);
    m.ball.state.vel.set(0, 0, 0);
    m.strikeableSide = "player";
    m.touchCount = 1; // already received: nothing will be taken automatically
    m.charging.player = 0;
    return { aim: { x: m.aimSpot.player.x, z: m.aimSpot.player.z } };
  });
  await page.keyboard.down("Space");
  await page.keyboard.down("KeyD"); // push the aim sideways while charging
  const charged = await settles(page, () => window.__teq.match.charging.player > 0.2, 30000);
  const held = await readMatch(page);
  await page.keyboard.up("KeyD");
  await page.keyboard.up("Space");
  check(charged, `holding the kick control charges it (${held.charging?.toFixed?.(2)} s)`);
  check(
    Math.abs(held.aim.z - before.aim.z) > 0.2 || Math.abs(held.aim.x - before.aim.x) > 0.2,
    `the stick moves the aim while it is held (${JSON.stringify(held.aim)})`
  );
  check(held.markerOn === true, "landscape shows the aim marker while aiming");
  // Not read straight back: a release is spent by the next simulation step,
  // and a software-rendered frame here can be a second long.
  const spent = await settles(page, () => window.__teq.match.charging.player === 0, 20000);
  check(spent, "letting go spends the charge");
  await page.close();
}

console.log("\nthe aim marker belongs to landscape only");
{
  // Portrait aims with the swipe that fires the kick, so there is nothing to
  // show before the gesture; landscape aims with a marker the stick moves.
  // The spread that decides whether a kick misses is unit-tested — four
  // hundred points is not something this browser can play.
  const portrait = await intoMatch({ width: 420, height: 860 });
  await settles(portrait, () => window.__teq.match.state === "serve_move", 120000);
  check((await readMatch(portrait)).markerOn === false, "portrait shows no aim marker");
  await portrait.close();
}

await browser.close();
if (failures.length) {
  console.log(`\n${failures.length} failed:`);
  for (const f of failures) console.log(` - ${f}`);
  process.exit(1);
}
console.log("\nall good");
