// Loads every venue in a real browser, counts what the GPU is asked to draw,
// and saves a screenshot of each.
//
// The count is the point. A backdrop's cost on a phone is draw calls, not
// triangles, and the number of meshes a GLB turns into is invisible from the
// file size — these arenas are 400-720 meshes over 15-21 materials. Run with
// `--no-merge` to load them unmerged and compare both numbers and pictures.
//
//   npm run build && npm run preview -- --port 5199 --strictPort
//   node scripts/venue-shots.mjs
//   node scripts/venue-shots.mjs --no-merge
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const PORT = Number(process.env.PORT ?? 5199);
const OUT = process.env.OUT ?? "/tmp/venues";
const MERGE = !process.argv.includes("--no-merge");
// LOW skips the backdrop entirely, which is the case worth looking at for a
// venue that plays on its backdrop's surface: it has to fall back to painting
// its own floor rather than leaving the players on nothing.
const QUALITY = process.env.QUALITY ?? "high";
// TOP=1 looks straight down from above the net. Perspective from the play
// camera cannot tell you whether a venue's painted centre line sits on the
// teqball court's centre line; this can.
const TOP = process.env.TOP === "1";
const VENUES = process.env.VENUES?.split(",") ?? ["gym", "basketball", "football", "tennis"];
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--no-sandbox"],
});

/**
 * Real draw calls per frame, counted by wrapping the engine's own draw entry
 * points for a couple of seconds.
 *
 * Counting meshes is not the same thing and would mislead in both directions:
 * a mesh with several submeshes is several calls, while a hundred instanced
 * copies of one mesh are a single instanced call. This is the number the phone
 * pays.
 */
async function drawCalls(page, seconds = 2) {
  return page.evaluate(async (secs) => {
    const engine = window.__teq?.engine;
    const scene = engine?.scenes?.[0];
    if (!scene) return null;
    let calls = 0;
    let frames = 0;
    const wrapped = ["drawElementsType", "drawArraysType"].map((name) => {
      const original = engine[name].bind(engine);
      engine[name] = (...args) => {
        calls++;
        return original(...args);
      };
      return name;
    });
    const observer = scene.onAfterRenderObservable.add(() => frames++);
    await new Promise((r) => setTimeout(r, secs * 1000));
    scene.onAfterRenderObservable.remove(observer);
    for (const name of wrapped) delete engine[name];
    return frames > 0 ? Math.round(calls / frames) : null;
  }, seconds);
}

/** Meshes and triangles, split by whether they belong to the backdrop. */
async function measure(page) {
  return page.evaluate(() => {
    const teq = window.__teq;
    const scene = teq?.engine?.scenes?.[0];
    if (!scene) return { error: "no scene" };
    const arena = scene.getTransformNodeByName("arena-wrapper");
    const inArena = new Set(arena ? arena.getChildMeshes(false).map((m) => m.uniqueId) : []);
    let arenaMeshes = 0;
    let arenaCalls = 0;
    let arenaTris = 0;
    let otherMeshes = 0;
    let otherCalls = 0;
    for (const m of scene.meshes) {
      if (m.getTotalVertices() === 0 || !m.isEnabled()) continue;
      const calls = Math.max(1, m.subMeshes ? m.subMeshes.length : 1);
      if (inArena.has(m.uniqueId)) {
        arenaMeshes++;
        arenaCalls += calls;
        arenaTris += m.getTotalIndices() / 3;
      } else {
        otherMeshes++;
        otherCalls += calls;
      }
    }
    const mats = new Set();
    for (const m of scene.meshes) if (inArena.has(m.uniqueId) && m.material) mats.add(m.material.uniqueId);
    // The crowd is thin instanced, so its real cost is figures x instances,
    // which no mesh count shows.
    let crowdFigures = 0;
    let crowdPeople = 0;
    let crowdTris = 0;
    for (const m of scene.meshes) {
      if (!m.name.startsWith("crowd-")) continue;
      const copies = m.thinInstanceCount || 1;
      crowdFigures++;
      crowdPeople += copies;
      crowdTris += (m.getTotalIndices() / 3) * copies;
    }
    // Same story for the scenery props: fifty models, one draw call each, and
    // a triangle count that only their instance count reveals.
    let propModels = 0;
    let propCopies = 0;
    let propTris = 0;
    for (const m of scene.meshes) {
      if (!/^(house|tree|car|palm|bush)_\d+$/.test(m.name)) continue;
      const copies = m.thinInstanceCount || 1;
      propModels++;
      propCopies += copies;
      propTris += (m.getTotalIndices() / 3) * copies;
    }
    return {
      arenaMeshes,
      arenaSubmeshes: arenaCalls,
      arenaTris: Math.round(arenaTris),
      arenaMaterials: mats.size,
      otherMeshes,
      otherSubmeshes: otherCalls,
      crowdFigures,
      crowdPeople,
      crowdTris: Math.round(crowdTris),
      propModels,
      propCopies,
      propTris: Math.round(propTris),
    };
  });
}

const rows = [];

for (const venue of VENUES) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });

  const url = `http://localhost:${PORT}/?q=${QUALITY}&venue=${venue}&intro=0${MERGE ? "" : "&merge=0"}`;
  await page.goto(url, { waitUntil: "load" });
  await page.waitForTimeout(4000);
  await page.locator("#btn-play").click();
  await page.locator("#btn-mode-friendly").click();
  await page.locator("#btn-diff-normal").click();
  // The character viewer loads two rigs before the start button does anything.
  await page.waitForTimeout(25000);
  await page.locator("#btn-start").click();
  // Both characters, the ball and the backdrop have to arrive before counting.
  await page.waitForFunction(() => window.__teq !== undefined, null, { timeout: 120000 });
  // Mid-establishing-shot, before it hands over to the play camera.
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}/${venue}-intro.png` });
  await page.waitForTimeout(12000);

  const m = await measure(page);
  const calls = await drawCalls(page);
  if (TOP) {
    await page.evaluate(() => {
      const scene = window.__teq.engine.scenes[0];
      // A clone, because the match drives the play camera every frame and
      // would put anything set here straight back.
      const top = scene.activeCamera.clone("top-down");
      top.position.set(0, 26, 0);
      top.setTarget(new scene.activeCamera.position.constructor(0, 0, 0.001));
      top.fov = 1.0;
      scene.activeCamera = top;
    });
    await page.waitForTimeout(1500);
  }
  const tag = `${TOP ? "top-" : ""}${QUALITY === "high" ? "" : QUALITY + "-"}${MERGE ? "merged" : "raw"}`;
  await page.screenshot({ path: `${OUT}/${venue}-${tag}.png` });
  rows.push({ venue, calls, ...m, errors: errors.slice(0, 3) });
  console.log(venue, JSON.stringify({ calls, ...m }));
  await page.close();
}

await browser.close();

console.log(`\n${MERGE ? "merged" : "unmerged"} — screenshots in ${OUT}`);
console.log("venue        draws/frame  arena meshes  submeshes  materials  triangles   crowd");
for (const r of rows) {
  if (r.error) {
    console.log(`${r.venue.padEnd(12)} ${r.error}`);
    continue;
  }
  console.log(
    `${r.venue.padEnd(12)} ${String(r.calls).padStart(11)} ${String(r.arenaMeshes).padStart(13)}` +
      ` ${String(r.arenaSubmeshes).padStart(10)} ${String(r.arenaMaterials).padStart(10)}` +
      ` ${String(r.arenaTris).padStart(10)}` +
      `   ${r.crowdPeople} people / ${r.crowdFigures} figures / ${r.crowdTris.toLocaleString()} tris`
  );
  console.log(
    `${" ".repeat(12)} props: ${r.propCopies} placed / ${r.propModels} models` +
      ` / ${r.propTris.toLocaleString()} tris`
  );
  for (const e of r.errors) console.log(`   ! ${e}`);
}
