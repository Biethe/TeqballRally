import { chromium } from "playwright-core";
import fs from "node:fs";

const BASE = "http://localhost:5173/?intro=0&light";
const SHOTS = "/home/bierh/TeqballRally/.verify-logs/shots";
fs.mkdirSync(SHOTS, { recursive: true });

const errors = { host: [], guest: [] };
const wire = { snaps: 0, fx: 0, fxKinds: {}, clipWinSeen: 0, inputs: 0 };

async function seed(page) {
  await page.addInitScript(() => {
    localStorage.setItem("teqopen.prefs", JSON.stringify({ coached: true }));
    window.__wire = [];
    const WS = window.WebSocket;
    window.WebSocket = class extends WS {
      constructor(...args) {
        super(...args);
        this.addEventListener("message", (ev) => {
          try {
            const m = JSON.parse(ev.data);
            window.__wire.push(m);
            if (window.__wire.length > 5000) window.__wire.splice(0, 2500);
          } catch {}
        });
      }
    };
  });
}

function watch(page, which) {
  page.on("console", (msg) => {
    if (msg.type() === "error") errors[which].push(msg.text().slice(0, 300));
  });
  page.on("pageerror", (e) => errors[which].push(String(e).slice(0, 300)));
}

const browser = await chromium.launch({
  executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome`,
  args: ["--use-gl=swiftshader"],
});
const hostCtx = await browser.newContext({ viewport: { width: 640, height: 360 } });
const guestCtx = await browser.newContext({ viewport: { width: 640, height: 360 } });
const host = await hostCtx.newPage();
const guest = await guestCtx.newPage();
await seed(host);
await seed(guest);
watch(host, "host");
watch(guest, "guest");

// The WebGL render loop keeps the page busy, so Playwright's screenshot
// stability wait never settles. CDP captures the frame directly.
const cdpHost = await hostCtx.newCDPSession(host);
const cdpGuest = await guestCtx.newCDPSession(guest);
const shot = async (cdp, name) => {
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(`${SHOTS}/${name}.png`, Buffer.from(data, "base64"));
};

const click = async (page, sel, label) => {
  await page.waitForSelector(sel, { timeout: 30000 });
  await page.$eval(sel, (el) => el.click());
  console.log(`[${label}] clicked ${sel}`);
};

await Promise.all([host.goto(BASE), guest.goto(BASE)]);
console.log("pages loaded");

// Host: title -> modes -> online -> host private room
await click(host, "#btn-play", "host");
await click(host, "#btn-mode-online", "host");
await click(host, "#btn-online-host", "host");
await host.waitForSelector(".lobby-code", { timeout: 20000 });
const code = (await host.textContent(".lobby-code")).trim();
console.log(`room code: ${code}`);

// Guest: title -> modes -> online -> join with code
await click(guest, "#btn-play", "guest");
await click(guest, "#btn-mode-online", "guest");
await click(guest, "#btn-online-join", "guest");
await guest.waitForSelector("#lobby-code-input", { timeout: 20000 });
await guest.fill("#lobby-code-input", code);
await guest.$eval("#btn-code-go", (el) => el.click());
console.log("[guest] joined with code");
await guest.waitForTimeout(1500);
console.log(
  "wire hook diag:",
  JSON.stringify({
    host: await host.evaluate(() => ({ n: window.__wire.length, ws: typeof window.WebSocket })),
    guest: await guest.evaluate(() => ({ n: window.__wire.length, ws: typeof window.WebSocket })),
  })
);

// Both should reach the character select, then the match.
for (const [p, n] of [[host, "host"], [guest, "guest"]]) {
  await p.waitForSelector("#btn-start", { state: "visible", timeout: 30000 });
  await p.$eval("#btn-start", (el) => el.click());
  console.log(`[${n}] confirmed select screen`);
}

// Wait for both loaders to clear (two software-GL contexts are slow).
for (let i = 0; i < 180; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const h = await host.evaluate(() => document.body.innerText.includes("RIVAL"));
  const g = await guest.evaluate(() => document.body.innerText.includes("RIVAL"));
  if (i % 15 === 0) console.log(`loader t=${i}s host=${h} guest=${g}`);
  if (h && g) break;
}
console.log("match live on both tabs");
await host.waitForTimeout(2000);
await shot(cdpHost, "host-00-matchstart");
await shot(cdpGuest, "guest-00-matchstart");
console.log("match start captured");

// Drive the host: serve, then keep the rally alive with periodic strikes and
// a bit of footwork. KeyJ strikes, WASD moves.
const rally = async (seconds) => {
  const until = Date.now() + seconds * 1000;
  let i = 0;
  while (Date.now() < until) {
    // Serve ownership alternates: strike on both tabs so whoever owns the
    // serve commits it.
    for (const p of [host, guest]) {
      await p.keyboard.down("KeyJ");
      await p.waitForTimeout(60);
      await p.keyboard.up("KeyJ");
    }
    const move = ["KeyA", "KeyD", "KeyW", "KeyS"][i % 4];
    await host.keyboard.down(move);
    await host.waitForTimeout(150);
    await host.keyboard.up(move);
    await host.waitForTimeout(300);
    i++;
  }
};

await rally(8);
await shot(cdpHost, "host-01-rally");
await shot(cdpGuest, "guest-01-rally");

// Add ~120 ms of latency on the guest's socket via CDP, then rally on.
const cdp = cdpGuest;
await cdp.send("Network.enable");
await cdp.send("Network.emulateNetworkConditions", {
  offline: false,
  latency: 120,
  downloadThroughput: 10 * 1024 * 1024,
  uploadThroughput: 2 * 1024 * 1024,
});
console.log("guest latency: +120ms");
await rally(10);
await shot(cdpHost, "host-02-lagged");
await shot(cdpGuest, "guest-02-lagged");

// Starvation probe: take the guest fully offline for 2 s mid-rally, restore.
await cdp.send("Network.emulateNetworkConditions", {
  offline: true,
  latency: 0,
  downloadThroughput: -1,
  uploadThroughput: -1,
});
await rally(2);
await cdp.send("Network.emulateNetworkConditions", {
  offline: false,
  latency: 120,
  downloadThroughput: 10 * 1024 * 1024,
  uploadThroughput: 2 * 1024 * 1024,
});
console.log("guest restored after 2 s offline");
await rally(8);
await shot(cdpHost, "host-03-after-starve");
await shot(cdpGuest, "guest-03-after-starve");

// Wire evidence from the guest side.
const msgs = await guest.evaluate(() => window.__wire);
for (const m of msgs) {
  if (m.t === "snap") {
    wire.snaps++;
    if (m.hostClipFrom !== undefined || m.guestClipFrom !== undefined) wire.clipWinSeen++;
  } else if (m.t === "fx") {
    wire.fx++;
    wire.fxKinds[m.kind] = (wire.fxKinds[m.kind] ?? 0) + 1;
  }
}
console.log("GUEST WIRE:", JSON.stringify(wire));
console.log("SNAP SAMPLE:", JSON.stringify(msgs.filter((m) => m.t === "snap").slice(-1)));
console.log("FX SAMPLES:", JSON.stringify(msgs.filter((m) => m.t === "fx").slice(0, 5)));
console.log("HOST ERRORS:", JSON.stringify(errors.host));
console.log("GUEST ERRORS:", JSON.stringify(errors.guest));

await browser.close();
console.log("done");
