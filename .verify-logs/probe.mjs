import { chromium } from "playwright-core";

const browser = await chromium.launch({
  executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome`,
  args: ["--use-gl=swiftshader"],
});
const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
await page.addInitScript(() => localStorage.setItem("teqopen.prefs", JSON.stringify({ coached: true })));
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning") console.log("CONSOLE", m.type(), m.text().slice(0, 200));
});
page.on("requestfailed", (r) => console.log("FAILED", r.url().slice(0, 120), r.failure()?.errorText));
page.on("response", (r) => {
  if (r.status() >= 400) console.log("HTTP", r.status(), r.url().slice(0, 120));
});
await page.goto("http://localhost:5173/?intro=0");
await page.waitForSelector("#btn-play", { timeout: 30000 });
await page.$eval("#btn-play", (el) => el.click());
await page.waitForSelector("#btn-mode-friendly", { timeout: 30000 });
await page.$eval("#btn-mode-friendly", (el) => el.click());
// difficulty menu -> normal starts a local match; watch the loader.
await page.waitForSelector("#btn-diff-normal", { timeout: 30000 });
await page.$eval("#btn-diff-normal", (el) => el.click());
console.log("friendly match requested; watching loader for 90s");
for (let i = 0; i < 90; i++) {
  await page.waitForTimeout(1000);
  const loading = await page.evaluate(() => document.body.innerText.includes("Loading"));
  if (!loading) {
    console.log("LOADER CLEARED after ~" + i + "s");
    break;
  }
}
await browser.close();
console.log("probe done");
