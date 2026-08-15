// Render one still per venue for the picker.
//
// The venue tab used to preview the live scene, which meant building an arena
// to decide whether you fancied playing in it — a 4.8 MB download and a scene
// swap for a choice made in two seconds. A picture says the same thing.
//
// Shot with the UI hidden and the camera placed for the card rather than for
// play: high, off to one side, looking down the court, so the picture reads as
// a place rather than as a gameplay screenshot.
//
//   npm run build && npm run preview -- --port 5199 --strictPort
//   node scripts/venue-cards.mjs
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const PORT = Number(process.env.PORT ?? 5199);
const OUT = "assets/venues";
const VENUES = process.env.VENUES?.split(",") ?? ["gym", "basketball", "football", "tennis"];
// The card is wide; the picker letterboxes it into the stage.
const WIDTH = 640;
const HEIGHT = 400;

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--no-sandbox"],
});

for (const venue of VENUES) {
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
  await page.goto(`http://localhost:${PORT}/?q=high&intro=0&venue=${venue}`, {
    waitUntil: "load",
  });
  await page.waitForFunction(() => window.__teq?.engine?.scenes?.length, null, {
    timeout: 300000,
  });
  // The arena streams in after the first frame; without this the card is a
  // picture of an empty court.
  await page.waitForTimeout(20000);

  await page.evaluate(() => {
    // No HUD, no menus, no coach: this is a photograph of the venue.
    const ui = document.getElementById("ui-root");
    if (ui) ui.style.display = "none";
    const scene = window.__teq.scene ?? window.__teq.engine.scenes[0];
    const camera = scene.activeCamera;
    // Off the corner and high, looking at the table. Far enough out that the
    // stands or the street read, near enough that the court is the subject.
    camera.position.set(-11, 8.5, -9);
    camera.setTarget(new (camera.position.constructor)(0, 1.2, 0));
    camera.fov = 0.9;
  });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${OUT}/${venue}.jpg`, type: "jpeg", quality: 82 });
  console.log(`${OUT}/${venue}.jpg`);
  await page.close();
}

await browser.close();
console.log(`\n${VENUES.length} venue cards written to ${OUT}`);
