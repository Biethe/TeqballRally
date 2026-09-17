// Checks that a competition does not leave the previous round's players on court.
//
// A cup or a league is the only flow that starts a match without leaving one
// first: every other route goes back to the menu, where `leaveMatch` disposes
// the pair. So it was the only route that leaked them, and it leaked exactly
// one pair per round — two idle bodies standing on court through round two,
// four through round three. A unit test cannot see this; the models only exist
// once a real rig has loaded into a real scene.
//
// The second thing checked here is that the finished match actually stops.
// The standings screen is opaque and the render loop had no blocking-screen
// guard, so the ball stayed live and the CPU kept playing behind it for as
// long as the player left the screen up.
//
// Usage:
//   npm run build:harness
//   npm run preview -- --port 5199 --strictPort
//   node scripts/verify-competition-rounds.mjs
//
// Set CHROMIUM_PATH if playwright-core cannot find a browser on its own.
import { chromium } from "playwright-core";

const fails = [];
const check = (ok, what) => { console.log(`${ok ? "  ok  " : " FAIL "} ${what}`); if (!ok) fails.push(what); };

const b = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--no-sandbox"],
});
const ctx = await b.newContext({ viewport: { width: 1280, height: 720 } });
const p = await ctx.newPage();
p.on("pageerror", (e) => fails.push("page error: " + e.message));

// Mark the lesson done, so the app opens on the menu instead of coaching.
await ctx.addInitScript(() => {
  localStorage.setItem("teqopen.prefs", JSON.stringify({ coached: true }));
});

await p.goto("http://localhost:5199/?q=low&intro=0", { waitUntil: "load" });

/** Click a menu button by id, once it is on screen and enabled. */
const press = async (id) => {
  await p.waitForSelector(`#${id}`, { state: "visible", timeout: 60000 });
  await p.click(`#${id}`);
};

/**
 * Wait for a *different* match than the one running now.
 *
 * Identity, not existence. `startMatch` loads the new rigs before it disposes
 * the old ones, so for a moment both pairs really are in the scene — waiting on
 * "a match exists" samples that window and reports a leak on a build that has
 * none. The controller is only published once the swap is done.
 */
const waitForNewMatch = async () => {
  await p.evaluate(() => { window.__probePrev = window.__teq?.match ?? null; });
  return async () => {
    await p.waitForFunction(() => {
      const m = window.__teq?.match;
      return Boolean(m) && m !== window.__probePrev && Boolean(m.chars?.player?.clipContactPoint);
    }, null, { timeout: 180000 });
    // Let a few frames run so every mesh of the new pair is in the scene.
    await p.waitForTimeout(1500);
  };
};

/**
 * Who is on court, and how much of the scene they account for.
 *
 * Counted by the wrapper node `Character` builds for each rig, not by meshes.
 * Two reasons. The models differ in how many primitives they are built from —
 * England is twelve, the others eleven — so a raw mesh count changes between
 * rounds simply because the opponent changed, and reads as a leak on a build
 * that has none. And the mesh names come from the art, which is not consistent
 * about them ("Brazil Footballer", "England footballer"); the wrapper name is
 * ours and is derived from the model file. Two player wrappers is the
 * invariant, whatever the two models happen to cost in meshes.
 */
const census = () => p.evaluate(() => {
  const scene = window.__teq.engine.scenes[0];
  return {
    meshes: scene.meshes.length,
    skeletons: scene.skeletons.length,
    // The arena and the table wrap themselves the same way; only the rigs are
    // loaded from a `…Player.glb`.
    players: scene.transformNodes
      .filter((n) => n.name.endsWith("Player-wrapper"))
      .map((n) => n.name)
      .sort(),
  };
});

/** End the running match immediately, as a win for the human. */
const winMatch = () => p.evaluate(() => {
  const m = window.__teq.match;
  m.sets.player = 1;   // SETS_TO_WIN - 1
  m.sets.ai = 0;
  m.score.player = 99; // past WIN_SCORE
  m.score.ai = 0;
  m.finishPoint();
});

console.log("\ninto a league");
await press("btn-play");
await press("btn-mode-competition");
await press("btn-format-league");
// The character/ball picker: play whatever it opens on.
await press("btn-start");
const round1Ready = await waitForNewMatch();
await press("btn-standings-continue");   // PLAY ROUND 1
await round1Ready();

const round1 = await census();
console.log(`  round 1: ${round1.players.join(" + ")} (${round1.meshes} meshes, ${round1.skeletons} skeletons)`);
check(round1.players.length === 2, `round 1 has two players on court (${round1.players.join(" + ")})`);

console.log("\nround 1 ends");
await winMatch();
await p.waitForSelector("#standings-screen:not(.hidden)", { timeout: 60000 });

// The court must be still behind the standings.
const before = await p.evaluate(() => {
  const s = window.__teq.match.ball.state ?? window.__teq.ball.state;
  return { x: s.pos.x, y: s.pos.y, z: s.pos.z };
});
await p.waitForTimeout(2000);
const after = await p.evaluate(() => {
  const s = window.__teq.match.ball.state ?? window.__teq.ball.state;
  return { x: s.pos.x, y: s.pos.y, z: s.pos.z };
});
const moved = Math.hypot(after.x - before.x, after.y - before.y, after.z - before.z);
check(moved < 0.01, `the ball is still behind the standings (moved ${moved.toFixed(3)} m in 2 s)`);

console.log("\ninto round 2");
const round2Ready = await waitForNewMatch();
await press("btn-standings-continue");   // PLAY NEXT ROUND
await round2Ready();
const round2 = await census();
console.log(`  round 2: ${round2.players.join(" + ")} (${round2.meshes} meshes, ${round2.skeletons} skeletons)`);

check(
  round2.players.length === 2,
  `round 2 still has two players on court, not four (${round2.players.join(" + ")})`
);
// The whole bug, stated directly: round 1's opponent must not still be stood
// there. A league changes opponent every round, so this is a real difference.
const gone = round1.players.filter((m) => !round2.players.includes(m));
check(
  gone.length === 1,
  `round 1's opponent left the court (${gone.join(", ") || "nobody left"})`
);
check(
  round2.skeletons <= round1.skeletons,
  `round 2 has no more skeletons than round 1 (${round1.skeletons} → ${round2.skeletons})`
);
check(
  await p.evaluate(() => window.__teq.match.tutorialFrozen !== true),
  "the new round did not open frozen"
);

await b.close();
console.log(fails.length ? `\n${fails.length} FAILED:\n  ` + fails.join("\n  ") : "\nall good");
process.exit(fails.length ? 1 : 0);
