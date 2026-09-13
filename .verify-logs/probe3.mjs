import { chromium } from "playwright-core";

const browser = await chromium.launch({
  executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome`,
  args: ["--use-gl=swiftshader"],
});
const mk = async (name) => {
  const ctx = await browser.newContext({ viewport: { width: 800, height: 450 } });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    localStorage.setItem("teqopen.prefs", JSON.stringify({ coached: true }));
    window.__wire = [];
    const WS = window.WebSocket;
    window.WebSocket = class extends WS {
      constructor(...args) {
        super(...args);
        this.addEventListener("message", (ev) => {
          try {
            window.__wire.push(JSON.parse(ev.data));
          } catch {}
        });
      }
    };
  });
  page.on("pageerror", (e) => console.log(`[${name}] PAGE-ERR`, String(e).slice(0, 300)));
  page.on("console", (m) => {
    if (m.type() === "error") console.log(`[${name}] CONSOLE`, m.text().slice(0, 300));
  });
  return page;
};
const click = async (p, s) => {
  await p.waitForSelector(s, { timeout: 30000 });
  await p.$eval(s, (el) => el.click());
};

const host = await mk("host");
const guest = await mk("guest");
await Promise.all([host.goto("http://localhost:5173/?intro=0&light"), guest.goto("http://localhost:5173/?intro=0&light")]);
await click(host, "#btn-play");
await click(host, "#btn-mode-online");
await click(host, "#btn-online-host");
await host.waitForSelector(".lobby-code", { timeout: 20000 });
const code = (await host.textContent(".lobby-code")).trim();
await click(guest, "#btn-play");
await click(guest, "#btn-mode-online");
await click(guest, "#btn-online-join");
await guest.fill("#lobby-code-input", code);
await guest.$eval("#btn-code-go", (el) => el.click());
for (const [p, n] of [[host, "host"], [guest, "guest"]]) {
  await p.waitForSelector("#btn-start", { state: "visible", timeout: 30000 });
  await p.$eval("#btn-start", (el) => el.click());
  console.log(n, "clicked start");
}

const snapOf = (p) =>
  p.evaluate(() => ({
    text: document.body.innerText.replace(/\s+/g, " ").slice(0, 90),
    kinds: window.__wire.map((m) => m.t).slice(-12),
    phases: [...new Set(window.__wire.filter((m) => m.t === "snap").map((m) => m.phase))],
  }));

for (let i = 0; i < 45; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const h = await snapOf(host);
  const g = await snapOf(guest);
  console.log(`t=${(i + 1) * 2}s`);
  console.log("  host :", JSON.stringify(h));
  console.log("  guest:", JSON.stringify(g));
  if (h.phases.length > 0) console.log("  (snaps flowing)");
}
await browser.close();
console.log("probe done");
