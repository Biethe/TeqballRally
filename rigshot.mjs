import { chromium } from "playwright-core";
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH,
  args: ["--no-sandbox","--no-proxy-server","--use-gl=angle","--use-angle=swiftshader"] });
const p = await b.newPage({ viewport: { width: 760, height: 480 } });
p.on("pageerror", e => console.log("[err]", e.message));
p.on("console", m => { if (m.text().includes("identical")) console.log("[c]", m.text()); });
await p.goto("http://localhost:5178/rigtest.html", { waitUntil: "load" });
await p.waitForFunction(() => window.__rig, null, { timeout: 180000 });
await p.waitForTimeout(12000); await p.screenshot({ path: "/tmp/c1.png" });
await p.waitForTimeout(8000);  await p.screenshot({ path: "/tmp/c2.png" });
await b.close();
