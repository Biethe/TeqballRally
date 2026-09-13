import { chromium } from "playwright-core";

const browser = await chromium.launch({
  executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome`,
  args: ["--use-gl=swiftshader"],
});
const mk = async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
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
  page.on("console", (m) => {
    if (m.type() === "error") console.log("CONSOLE-ERR", m.text().slice(0, 250));
  });
  page.on("pageerror", (e) => console.log("PAGE-ERR", String(e).slice(0, 250)));
  return page;
};
const click = async (p, s) => {
  await p.waitForSelector(s, { timeout: 30000 });
  await p.$eval(s, (el) => el.click());
};

const host = await mk();
const guest = await mk();
await Promise.all([host.goto("http://localhost:5173/?intro=0"), guest.goto("http://localhost:5173/?intro=0")]);
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

for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const h = await host.evaluate(() => ({
    loading: document.body.innerText.includes("Loading"),
    kinds: [...new Set(window.__wire.map((m) => m.t))],
  }));
  const g = await guest.evaluate(() => ({
    loading: document.body.innerText.includes("Loading"),
    kinds: [...new Set(window.__wire.map((m) => m.t))],
  }));
  if (i % 5 === 0 || (!h.loading && !g.loading)) {
    console.log(`t=${i}s host`, JSON.stringify(h), "guest", JSON.stringify(g));
  }
  if (!h.loading && !g.loading) {
    console.log("BOTH LOADED");
    break;
  }
}
await browser.close();
console.log("probe done");
