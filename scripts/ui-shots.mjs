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
    /**
     * Whether some ancestor scrolls this element into view.
     *
     * A control below the fold of a scrollable list is reachable, which is not
     * the same defect as one drawn off the edge of a screen that cannot move.
     * Without this the settings list — deliberately scrollable on a phone held
     * sideways — reported every row past the third as broken.
     */
    const scrollsIntoView = (el) => {
      for (let p = el.parentElement; p; p = p.parentElement) {
        const s = getComputedStyle(p);
        const scrolls = /(auto|scroll)/.test(s.overflowY) && p.scrollHeight > p.clientHeight + 1;
        if (scrolls) return true;
      }
      return false;
    };
    /** Whether a point is inside every scrolling ancestor's visible area. */
    const inScrollerView = (el, x, y) => {
      for (let p = el.parentElement; p; p = p.parentElement) {
        const s = getComputedStyle(p);
        if (!/(auto|scroll)/.test(s.overflowY)) continue;
        const box = p.getBoundingClientRect();
        if (y < box.top || y > box.bottom || x < box.left || x > box.right) return false;
      }
      return true;
    };
    // Anything interactive that a finger cannot reach is a real defect.
    for (const el of document.querySelectorAll("button, input, .menu-option")) {
      if (!visible(el) || !el.offsetParent) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (
        !scrollsIntoView(el) &&
        (r.left < -1 || r.top < -1 || r.right > vw + 1 || r.bottom > vh + 1)
      ) {
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
      // A control straddling the fold of a scrollable list has its centre
      // clipped away, so the hit test lands on whatever is behind the list.
      // That is a scroll position, not a control someone drew over.
      if (scrollsIntoView(el) && !inScrollerView(el, cx, cy)) continue;
      const hit = document.elementFromPoint(cx, cy);
      // A modal is meant to cover what is behind it. Only the dialog's own
      // controls are auditable while one is up.
      const modal = document.querySelector("#pause-screen:not(.hidden)");
      if (modal && modal.contains(hit) && !modal.contains(el)) continue;
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
  await page.goto(`http://localhost:${PORT}/?q=low&intro=0`, { waitUntil: "load" });
  await page.waitForTimeout(3500);

  const shot = async (name) => {
    await page.screenshot({ path: `${OUT}/${dev.name}-${name}.png` });
    allProblems.push(...(await audit(page, `${dev.name}/${name}`)));
  };

  await shot("title");
  await page.locator("#btn-play").click();
  await page.waitForTimeout(400);
  await shot("play");

  await page.locator("#btn-mode-online").click();
  await page.waitForTimeout(300);
  await shot("online");

  await page.locator("#btn-online-join").click();
  await page.waitForTimeout(400);
  await shot("code-entry");

  // Code entry -> online menu -> play menu -> title, then in through the
  // settings door. Missing a step here is easy: without it the settings
  // screens are never reached and every check on them passes for nothing.
  await page.locator("#btn-code-back").click();
  await page.waitForTimeout(300);
  await page.locator("#btn-menu-back").click();
  await page.waitForTimeout(300);
  await page.locator("#btn-menu-back").click();
  await page.waitForTimeout(400);
  // The career screens, seeded so the cards have something on them: an empty
  // roster and three untouched challenges lay out nothing like a career in
  // progress, which is the state a layout defect would show up in.
  await page.evaluate(() => {
    localStorage.setItem(
      "teqopen.career",
      JSON.stringify({
        coins: 1487,
        trophies: 365,
        best: 365,
        champions: {
          BrazilianPlayer: { level: 3, xp: 1 },
          EnglishPlayer: { level: 1, xp: 0 },
          FrenchPlayer: { level: 6, xp: 0 },
        },
        day: new Date().toISOString().slice(0, 10),
        progress: {},
        claimed: [],
      })
    );
  });
  await page.reload({ waitUntil: "load" });
  await page.waitForTimeout(3000);
  // The recovery code, shown directly: reaching it needs a server the layout
  // harness does not run, and what is being checked is the card.
  await page.evaluate(() => {
    window.__teqUi?.showRecoveryCode({
      code: "T3QR-4LLY-9F2K-8B7M",
      note: null,
      onDone: () => {},
    });
  });
  await page.waitForTimeout(400);
  await shot("recovery-code");
  await page.evaluate(() => {
    window.__teqUi?.showRestore({ message: null, busy: false, onRestore: () => {}, onBack: () => {} });
  });
  await page.waitForTimeout(400);
  await shot("restore");

  // The friends list, with rows: the harness has no server, and an empty list
  // lays out nothing like a full one.
  await page.evaluate(() => {
    window.__teqUi?.showFriends({
      rows: [
        { id: "AAAA1111", name: "Kwame", trophies: 1502, tier: "PRO II", online: true, seen: "" },
        { id: "BBBB2222", name: "Léa", trophies: 980, tier: "JUNIOR II", online: true, seen: "" },
        { id: "CCCC3333", name: "Marco_88", trophies: 640, tier: "JUNIOR I", online: false, seen: "Seen today" },
        { id: "DDDD4444", name: "Yuki", trophies: 310, tier: "ROOKIE III", online: false, seen: "Not for a while" },
      ],
      myCode: "7Z9WYS4A",
      message: null,
      busy: false,
      onAdd: () => {},
      onRemove: () => {},
      onBack: () => {},
    });
  });
  await page.waitForTimeout(400);
  await shot("friends");
  await page.goto(`http://localhost:${PORT}/?q=low&intro=0`, { waitUntil: "load" });
  await page.waitForTimeout(2500);

  await page.locator("#btn-title-champions").click();
  await page.waitForTimeout(400);
  await shot("champions");
  await page.locator("#champions-screen .select-back").click();
  await page.waitForTimeout(300);
  await page.locator("#btn-title-challenges").click();
  await page.waitForTimeout(400);
  await shot("challenges");
  await page.locator("#challenges-screen .select-back").click();
  await page.waitForTimeout(300);

  // The account screens. The API is not running in this harness, so the
  // signed-out state is what is captured — which is the state that has the
  // form, the pitch and the warning on it, and the one worth checking.
  await page.locator("#btn-title-profile").click();
  await page.waitForTimeout(500);
  await shot("profile");
  await page.locator("#profile-screen .select-back").click();
  await page.waitForTimeout(300);

  await page.locator("#btn-title-settings").click();
  await page.waitForTimeout(400);
  await shot("settings");

  await page.locator("#btn-set-display").click();
  await page.waitForTimeout(400);
  await shot("settings-display");
  // The graphics row asks before it restarts anything, and that dialog is a
  // screen of its own worth checking the layout of.
  await page.locator(".setting-row .seg-btn").nth(1).click();
  await page.waitForTimeout(300);
  await shot("graphics-warning");
  await page.locator(".pause-actions .big-btn").nth(1).click();
  await page.waitForTimeout(300);
  await page.locator("#btn-settings-back").click();
  await page.waitForTimeout(300);

  await page.goto(`http://localhost:${PORT}/?q=low&intro=0`, { waitUntil: "load" });
  await page.waitForTimeout(3000);
  await page.locator("#btn-play").click();
  await page.locator("#btn-mode-friendly").click();
  await page.waitForTimeout(300);
  await shot("difficulty");
  await page.locator("#btn-diff-normal").click();
  await page.waitForTimeout(12000);
  await shot("select");

  // The results screen, shown directly. Playing a match out to reach it would
  // take this browser several minutes, and what is being checked is the
  // layout of a card, not the road to it.
  await page.evaluate(() => {
    window.__teqUi?.showResult({
      won: true,
      trophies: 20,
      total: 385,
      coins: 91,
      tier: "ROOKIE III",
      nextTier: "JUNIOR I",
      toNext: 115,
      progress: 0.42,
      rank: "promoted",
      notes: ["LEVEL UP — BRAZIL LEVEL 4", "CHALLENGE COMPLETE — Win 3 matches"],
      onContinue: () => {},
      onRematch: () => {},
    });
  });
  await page.waitForTimeout(400);
  await shot("result");

  // The head-to-head card, likewise shown directly: it lives for a few seconds
  // at the start of a match and is gone before this browser has drawn it.
  await page.evaluate(() => {
    // The card lives inside the HUD so the establishing camera move is never
    // covered by a full-screen panel — which means the HUD has to be up, and
    // the results card from the previous shot has to come down.
    document.getElementById("result-screen")?.classList.add("hidden");
    const ui = window.__teqUi;
    ui?.showHUD();
    const roster = window.__teqCharacters ?? [];
    ui?.showIntro("SPORTS HALL", "YOU", "ENGLAND", [roster[0], roster[1]]);
  });
  await page.waitForTimeout(1500);
  await shot("head-to-head");

  // The leaderboard, with rows: the harness has no server, so it is shown
  // directly. An empty table lays out nothing like a full one.
  await page.evaluate(() => {
    document.getElementById("hud")?.classList.add("hidden");
    const rows = [
      { rank: 1, id: "AAAA1111", name: "Ana Silva", trophies: 1840, tier: "PRO II", isMe: false },
      { rank: 2, id: "BBBB2222", name: "Kwame", trophies: 1502, tier: "PRO II", isMe: false },
      { rank: 3, id: "CCCC3333", name: "Léa", trophies: 980, tier: "JUNIOR II", isMe: false },
      { rank: 4, id: "DDDD4444", name: "Marco_88", trophies: 640, tier: "JUNIOR I", isMe: false },
      { rank: 5, id: "EEEE5555", name: "Yuki", trophies: 310, tier: "ROOKIE III", isMe: false },
    ];
    window.__teqUi?.showLeaderboard({
      rows,
      total: 218,
      me: { rank: 42, id: "MEME0000", name: "You", trophies: 165, tier: "ROOKIE II", isMe: true },
      message: null,
      onBack: () => {},
    });
  });
  await page.waitForTimeout(400);
  await shot("leaderboard");

  // The season card, shown directly: reaching it takes a month.
  await page.evaluate(() => {
    window.__teqUi?.showSeason({
      season: "2026-08",
      tier: "PRO II",
      best: 1840,
      coins: 1500,
      from: 1780,
      to: 890,
      onDone: () => {},
    });
  });
  await page.waitForTimeout(400);
  await shot("season");

  // The profile with a shelf of finished seasons on it, which is the state the
  // signed-out capture above cannot reach.
  await page.evaluate(() => {
    window.__teqUi?.showProfile({
      profile: {
        id: "7Z9WYS4A",
        name: "Ana Silva",
        trophies: 890,
        tier: "JUNIOR II",
        matches: 214,
        rank: 12,
      },
      message: null,
      freshStart: null,
      titles: [
        { season: "2026-06", tier: "JUNIOR I", best: 720 },
        { season: "2026-07", tier: "JUNIOR III", best: 1180 },
        { season: "2026-08", tier: "PRO II", best: 1840 },
      ],
      busy: false,
      onCreate: () => {},
      onRename: () => {},
      onRestore: () => {},
      onNewCode: () => {},
      onFriends: () => {},
      onLeaderboard: () => {},
      onBack: () => {},
    });
  });
  await page.waitForTimeout(400);
  await shot("profile-titles");

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
