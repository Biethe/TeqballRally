// Captures every screen at real phone dimensions so layout problems can be
// seen rather than guessed at.
//
//   npm run build && npm run preview -- --port 5199 --strictPort
//   node scripts/ui-shots.mjs
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const PORT = Number(process.env.PORT ?? 5199);
const OUT = process.env.OUT ?? "/tmp/ui";
mkdirSync(OUT, { recursive: true });

// The two devices this is actually played on, in CSS pixels.
const DEVICES = [
  { name: "a20e-landscape", width: 760, height: 360, dpr: 2 },
  { name: "s21-landscape", width: 854, height: 384, dpr: 2.8 },
  { name: "a20e-portrait", width: 360, height: 760, dpr: 2 },
];

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--no-sandbox"],
});

/** Report anything drawn outside the viewport or overlapping a sibling. */
async function audit(page, label) {
  return page.evaluate((name) => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const problems = [];
    const visible = (el) => {
      const s = getComputedStyle(el);
      return s.display !== "none" && s.visibility !== "hidden" && Number(s.opacity) > 0.05;
    };
    // Anything interactive that a finger cannot reach is a real defect.
    for (const el of document.querySelectorAll("button, input, .menu-option")) {
      if (!visible(el) || !el.offsetParent) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.left < -1 || r.top < -1 || r.right > vw + 1 || r.bottom > vh + 1) {
        problems.push({
          screen: name,
          what: el.id || el.className || el.tagName,
          issue: "outside the viewport",
          rect: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)],
          viewport: [vw, vh],
        });
      }
      // Apple and Google both put the minimum comfortable target near 44px.
      if (r.height > 0 && r.height < 40) {
        problems.push({
          screen: name,
          what: el.id || el.className || el.tagName,
          issue: `tap target only ${Math.round(r.height)}px tall`,
        });
      }
    }
    // A button can be inside the viewport and still unusable because
    // something is drawn over it. Hit-test the point a finger would land on:
    // if the topmost element there is not the button (or part of it), the tap
    // goes somewhere else.
    for (const el of document.querySelectorAll("button, input")) {
      if (!visible(el) || !el.offsetParent) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      const cx = Math.round(r.left + r.width / 2);
      const cy = Math.round(r.top + r.height / 2);
      if (cx < 0 || cy < 0 || cx > vw || cy > vh) continue;
      const hit = document.elementFromPoint(cx, cy);
      if (hit && hit !== el && !el.contains(hit)) {
        problems.push({
          screen: name,
          what: el.id || el.className || el.tagName,
          issue: "covered by " + (hit.id || hit.className || hit.tagName),
        });
      }
    }

    // Panels that are not meant to sit on top of each other. A pointer-events
    // none overlay passes the hit test above while still visually covering a
    // control, which is what the abilities panel did to the browse arrows.
    const shouldNotOverlap = [".player-profile", ".browse", "#btn-start", ".tabs", ".select-title"];
    const boxes = shouldNotOverlap
      .map((sel) => ({ sel, el: document.querySelector(sel) }))
      .filter(({ el }) => el && visible(el) && el.offsetParent)
      .map(({ sel, el }) => ({ sel, r: el.getBoundingClientRect() }));
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        const ox = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
        const oy = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
        if (ox > 2 && oy > 2) {
          problems.push({
            screen: name,
            what: a.sel,
            issue: `overlaps ${b.sel} by ${Math.round(ox)}x${Math.round(oy)}px`,
          });
        }
      }
    }

    // Text cut off mid-line reads as a broken layout, and is invisible to
    // every check above: the element is in bounds, tappable and unobscured.
    for (const el of document.querySelectorAll(".player-profile, .standings-row, .menu-option, .lobby-code")) {
      if (!visible(el) || !el.offsetParent) continue;
      if (el.scrollHeight > el.clientHeight + 2 || el.scrollWidth > el.clientWidth + 2) {
        problems.push({
          screen: name,
          what: el.id || el.className,
          issue: `content clipped (${el.scrollWidth}x${el.scrollHeight} in ${el.clientWidth}x${el.clientHeight})`,
        });
      }
    }

    // Does the page scroll sideways, or overflow its own height?
    if (document.documentElement.scrollHeight > vh + 2) {
      problems.push({ screen: name, what: "page", issue: `content ${document.documentElement.scrollHeight}px tall in ${vh}px` });
    }
    return problems;
  }, label);
}

const allProblems = [];

for (const dev of DEVICES) {
  const ctx = await browser.newContext({
    viewport: { width: dev.width, height: dev.height },
    deviceScaleFactor: dev.dpr,
    hasTouch: true,
    isMobile: true,
  });
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${PORT}/?q=low`, { waitUntil: "load" });
  await page.waitForTimeout(3500);

  const shot = async (name) => {
    await page.screenshot({ path: `${OUT}/${dev.name}-${name}.png` });
    allProblems.push(...(await audit(page, `${dev.name}/${name}`)));
  };

  await shot("title");
  await page.locator("#btn-play").click();
  await page.waitForTimeout(400);
  await shot("modes");

  await page.locator("#btn-mode-online").click();
  await page.waitForTimeout(300);
  await shot("online");

  await page.locator("#btn-online-join").click();
  await page.waitForTimeout(400);
  await shot("code-entry");

  // Code entry -> online menu -> mode menu. The second step is easy to miss:
  // without it the settings screens below are never reached and every check on
  // them passes for the wrong reason.
  await page.locator("#btn-code-back").click();
  await page.waitForTimeout(300);
  await page.locator("#btn-menu-back").click();
  await page.waitForTimeout(300);
  await page.locator("#btn-mode-settings").click();
  await page.waitForTimeout(300);
  await shot("settings");

  // Both settings sub-screens: the venue list is the longest menu in the game.
  await page.locator("#btn-settings-venue").click();
  await page.waitForTimeout(300);
  await shot("venue");
  // "gym" is the venue already in use, so this returns rather than reloading.
  await page.locator("#btn-venue-gym").click();
  await page.waitForTimeout(300);
  await page.locator("#btn-settings-graphics").click();
  await page.waitForTimeout(300);
  await shot("graphics");

  await page.goto(`http://localhost:${PORT}/?q=low`, { waitUntil: "load" });
  await page.waitForTimeout(3000);
  await page.locator("#btn-play").click();
  await page.locator("#btn-mode-friendly").click();
  await page.waitForTimeout(300);
  await shot("difficulty");
  await page.locator("#btn-diff-normal").click();
  await page.waitForTimeout(12000);
  await shot("select");

  await ctx.close();
  console.log(`captured ${dev.name}`);
}

await browser.close();

if (allProblems.length === 0) {
  console.log("no layout problems found");
} else {
  console.log(`\n${allProblems.length} layout problems:`);
  for (const p of allProblems) console.log(" ", JSON.stringify(p));
}
