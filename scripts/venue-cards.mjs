// Render presentation cards and top-down views per venue for the picker and review.
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const PORT = Number(process.env.PORT ?? 5199);
const OUT = "assets/venues";
const VENUES = process.env.VENUES?.split(",") ?? ["gym", "basketball", "football", "tennis"];
const WIDTH = 960;
const HEIGHT = 600;

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--no-sandbox"],
});

for (const venue of VENUES) {
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
  page.on("console", (msg) => console.log(`[${venue}]`, msg.text()));
  page.on("pageerror", (err) => console.error(`[${venue} ERR]`, err.message));
  await page.goto(`http://localhost:${PORT}/?q=high&intro=0&venue=${venue}`, {
    waitUntil: "load",
  });
  await page.waitForFunction(() => window.__teq?.engine?.scenes?.length, null, {
    timeout: 300000,
  });
  await page.waitForTimeout(10000);

  // 1. Angled presentation shot
  await page.evaluate((indoor) => {
    const ui = document.getElementById("ui-root");
    if (ui) ui.style.display = "none";
    const scene = window.__teq.scene ?? window.__teq.engine.scenes[0];
    for (const name of ["aim-marker", "landing-marker", "tap-marker"]) {
      scene.getMeshByName(name)?.dispose();
    }
    const camera = scene.activeCamera;
    if (indoor) {
      camera.position.set(-9, 5.5, -3);
      camera.setTarget(new (camera.position.constructor)(0, 1.0, 0));
      camera.fov = 0.92;
      camera.minZ = 4.5;
    } else {
      camera.position.set(-13.5, 8.0, 10.0);
      camera.setTarget(new (camera.position.constructor)(0, 0.9, 0));
      camera.fov = 0.82;
      camera.minZ = 0.1;
    }
  }, venue === "gym");

  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${OUT}/${venue}.jpg`, type: "jpeg", quality: 88 });
  console.log(`Saved card: ${OUT}/${venue}.jpg`);

  // 2. Top-down view (for outdoor venues)
  if (venue !== "gym") {
    await page.evaluate(() => {
      const scene = window.__teq.scene ?? window.__teq.engine.scenes[0];
      const camera = scene.activeCamera;
      camera.position.set(0.01, 85.0, 0);
      camera.setTarget(new (camera.position.constructor)(0, 0, 0));
      camera.fov = 1.12;
    });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `${OUT}/${venue}_top.jpg`, type: "jpeg", quality: 88 });
    console.log(`Saved top-view: ${OUT}/${venue}_top.jpg`);
  }

  await page.close();
}

await browser.close();
console.log(`\nVenue capture complete in ${OUT}`);

