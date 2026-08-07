// Drives the online lobby in headless Chromium against a real relay, and
// checks that two independent browser contexts are actually paired.
//
// This is the check unit tests cannot make: the lobby only works if the menu
// wiring, the endpoint resolution, the socket and the relay all agree.
//
//   npm run relay &
//   npm run build && npm run preview -- --port 5199 --strictPort
//   node scripts/verify-lobby.mjs
import { chromium } from "playwright-core";

const PORT = Number(process.env.PORT ?? 5199);
const RELAY = process.env.RELAY_PORT ?? 8787;
const base = `http://localhost:${PORT}/?ts=10&q=low&intro=0`;

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--no-sandbox"],
});

const errors = [];
async function openClient(label) {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 560 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => {
    errors.push(`${label} pageerror: ${e.message}`);
    console.log(`[${label}]`, e.message);
  });
  page.on("console", (m) => {
    if (m.type() === "error") {
      errors.push(`${label} console: ${m.text()}`);
      console.log(`[${label}]`, m.text());
    }
  });
  await page.goto(base, { waitUntil: "load" });
  await page.waitForTimeout(3500);
  await page.locator("#btn-play").click();
  await page.locator("#btn-mode-online").click();
  return page;
}

const a = await openClient("A");
const b = await openClient("B");
console.log("both clients reached the online menu");

// Both take the quick-match path; the relay should pair them.
await a.locator("#btn-online-quick").click();
await a.waitForTimeout(800);
const aWaiting = await a.locator("#lobby-detail").textContent();
console.log("A status:", JSON.stringify(aWaiting));

await b.locator("#btn-online-quick").click();

// Pairing moves both clients on to the character picker.
const paired = await Promise.all(
  [a, b].map((p) =>
    p
      .locator("#btn-start")
      .waitFor({ state: "visible", timeout: 20000 })
      .then(() => true)
      .catch(() => false)
  )
);
console.log("reached character select:", paired);

// The relay should show one room and nobody left waiting.
const health = await (await fetch(`http://127.0.0.1:${RELAY}/healthz`)).json();
console.log("relay:", JSON.stringify(health));

await a.screenshot({ path: "/tmp/lobby-a.png" });
await browser.close();

const checks = [
  ["A waited for an opponent", /waiting/i.test(aWaiting ?? "")],
  ["both clients paired", paired.every(Boolean)],
  ["relay opened one room", health.rooms === 1],
  ["queue drained", health.waiting === 0],
  ["no page errors", errors.length === 0],
];
for (const [name, ok] of checks) console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
const passed = checks.every(([, ok]) => ok);
console.log(passed ? "lobby verified" : "lobby verification FAILED");
if (errors.length) console.log(errors.slice(0, 5));
process.exit(passed ? 0 : 1);
