// Checks that the game and the server can actually talk to each other.
//
// `tests/backend.test.ts` drives the server over real HTTP, and
// `tests/accounts.test.ts` checks the rules behind it — but neither of them is
// a browser. The things that only break in one are exactly the things this
// catches: a cross-origin reply the page is not allowed to read, a base URL
// derived wrongly, a form that never reaches `fetch`.
//
// Usage:
//   npm run build
//   npm run relay                                   # port 8787
//   npm run preview -- --port 5199 --strictPort
//   node scripts/verify-accounts.mjs
//
// Set CHROMIUM_PATH if playwright-core cannot find a browser on its own.
import { chromium } from "playwright-core";

const PORT = Number(process.env.PORT ?? 5199);
const RELAY = Number(process.env.RELAY_PORT ?? 8787);
const BASE = `http://localhost:${PORT}/`;

const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${what}`);
  if (!ok) failures.push(what);
};

// A name nobody else has taken, since the store outlives the run.
const NAME = `Probe ${Math.random().toString(36).slice(2, 7)}`;

const health = await fetch(`http://localhost:${RELAY}/healthz`).then(
  (r) => r.json(),
  () => null
);
if (!health?.ok) {
  console.error(`no server on :${RELAY} — run: npm run relay`);
  process.exit(1);
}

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--no-sandbox", "--no-proxy-server"],
});
const page = await browser.newPage({ viewport: { width: 390, height: 780 }, hasTouch: true });
page.on("pageerror", (e) => failures.push(`page error: ${e.message}`));

console.log("\nsigning up from the game");
await page.goto(`${BASE}?q=medium&intro=0`, { waitUntil: "load" });
await page.waitForTimeout(3000);

await page.locator("#btn-title-profile").click();
await page.waitForTimeout(600);
check(await page.locator("#profile-name").isVisible(), "the profile screen offers a name");

// The client's own validation answers before any request is made.
await page.locator("#profile-name").fill("x");
await page.locator("#btn-profile-create").click();
await page.waitForTimeout(400);
const shortMsg = await page.locator(".account-message").textContent();
check(Boolean(shortMsg?.trim()), `a name that is too short is refused locally (${shortMsg?.trim()})`);

await page.locator("#profile-name").fill(NAME);
await page.locator("#btn-profile-create").click();

// The recovery code comes first, and cannot be got past without acknowledging.
const recovery = await page
  .waitForFunction(() => document.querySelector(".recovery-code")?.textContent?.trim() || null, null, {
    timeout: 20000,
    polling: 250,
  })
  .then((h) => h.jsonValue())
  .catch(() => null);
check(Boolean(recovery), `the server issued a recovery code (${recovery})`);
check(
  /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/.test(recovery ?? ""),
  "and it is four groups a person could copy onto paper"
);
await page.locator("#btn-recovery-done").click();
await page.waitForTimeout(600);

const code = await page.locator(".account-code-value").textContent();
check(Boolean(code?.trim()), `the server issued a player code (${code?.trim()})`);
check(/^[0-9A-HJKMNP-TV-Z]{8}$/.test(code?.trim() ?? ""), "and it is a code a person could read out");

const stored = await page.evaluate(() => localStorage.getItem("teqopen.identity"));
check(Boolean(stored && JSON.parse(stored).token), "the device kept the token");

console.log("\nthe leaderboard");
await page.locator("#btn-profile-board").click();
const rows = await page
  .waitForFunction(() => document.querySelectorAll(".board-row").length, null, {
    timeout: 20000,
    polling: 250,
  })
  .then((h) => h.jsonValue())
  .catch(() => 0);
check(rows > 0, `the board came back with rows (${rows})`);
check(
  (await page.locator(".board-row.me").count()) > 0,
  "and the player can see themselves on it"
);

console.log("\nthe name reaches the title screen");
await page.locator("#board-screen .select-back").click();
await page.waitForTimeout(400);
await page.locator("#profile-screen .select-back").click();
await page.waitForTimeout(600);
const chip = await page.locator("#btn-title-profile").textContent();
check(chip?.trim() === NAME, `the profile chip wears the player's name (${chip?.trim()})`);

console.log("\nfriends");
{
  // A second account to be friends with, made through the API rather than the
  // UI: what is being checked is the list, not a second sign-up.
  const other = await fetch(`http://localhost:${RELAY}/api/players`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: `Rival ${Math.random().toString(36).slice(2, 7)}` }),
  }).then((r) => r.json());

  await page.locator("#btn-title-profile").click();
  await page.waitForTimeout(600);
  await page.locator("#btn-profile-friends").click();
  await page.waitForTimeout(1200);
  check(await page.locator("#friend-code").isVisible(), "the friends screen takes a code");

  await page.locator("#friend-code").fill("ZZZZZZZZ");
  await page.locator("#btn-friend-add").click();
  await page.waitForTimeout(1500);
  const unknown = await page.locator("#friends-screen .account-message").textContent();
  check(Boolean(unknown?.trim()), `a code nobody holds is refused (${unknown?.trim()})`);

  await page.locator("#friend-code").fill(other.id);
  await page.locator("#btn-friend-add").click();
  const added = await page
    .waitForFunction(() => document.querySelectorAll(".friend-row").length, null, {
      timeout: 20000,
      polling: 250,
    })
    .then((h) => h.jsonValue())
    .catch(() => 0);
  check(added === 1, `adding by code puts them on the list (${added})`);
  check(
    (await page.locator(".friend-row .friend-name").textContent())?.startsWith("Rival") === true,
    "under their own name"
  );

  // …and it is mutual, without the other side having done anything.
  const theirs = await fetch(`http://localhost:${RELAY}/api/players/me/friends`, {
    headers: { authorization: `Bearer ${other.token}` },
  }).then((r) => r.json());
  check(theirs.friends?.length === 1, "and on theirs, without them lifting a finger");

  await page.locator(".friend-remove").click();
  await page.waitForTimeout(1500);
  check((await page.locator(".friend-row").count()) === 0, "removing takes them off again");
  await page.locator("#friends-screen .select-back").click();
  await page.waitForTimeout(500);
  await page.locator("#profile-screen .select-back").click();
  await page.waitForTimeout(600);
}

console.log("\nclubs");
{
  await page.locator("#btn-title-profile").click();
  await page.waitForTimeout(600);
  await page.locator("#btn-profile-club").click();
  await page.waitForTimeout(1500);
  check(await page.locator("#club-name").isVisible(), "the club screen offers both doors");
  check(await page.locator("#club-code").isVisible(), "start one, or join one");

  // The client refuses a code of the wrong shape without a round trip.
  await page.locator("#club-code").fill("ABC");
  await page.locator("#btn-club-join").click();
  await page.waitForTimeout(600);
  const shortCode = await page.locator("#club-screen .account-message").textContent();
  check(Boolean(shortCode?.trim()), `a code of the wrong length is refused locally (${shortCode?.trim()})`);

  const clubName = `Probe Club ${Math.random().toString(36).slice(2, 6)}`;
  await page.locator("#club-name").fill(clubName);
  await page.locator("#btn-club-create").click();
  const invite = await page
    .waitForFunction(
      () => document.querySelector("#club-screen .account-code-value")?.textContent?.trim() || null,
      null,
      { timeout: 20000, polling: 250 }
    )
    .then((h) => h.jsonValue())
    .catch(() => null);
  check(Boolean(invite), `creating a club shows the owner the invite code (${invite})`);
  check((await page.locator(".club-row").count()) === 1, "with the founder as its only member");
  check(
    (await page.locator(".club-owner").count()) === 1,
    "and the owner marked on the board"
  );

  // Somebody else joining, through the API: what is being checked here is that
  // the board this browser is looking at is the one the server holds.
  const recruit = await fetch(`http://localhost:${RELAY}/api/players`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: `Recruit ${Math.random().toString(36).slice(2, 7)}` }),
  }).then((r) => r.json());
  const joined = await fetch(`http://localhost:${RELAY}/api/clubs/join`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${recruit.token}` },
    body: JSON.stringify({ code: invite }),
  }).then((r) => r.json());
  check(joined.club?.members?.length === 2, "the code lets somebody else in");
  // …and they are not shown a code they have no business handing out.
  check(joined.club?.invite === null, "who is not shown the code themselves");

  await page.locator("#club-screen .select-back").click();
  await page.waitForTimeout(500);
  await page.locator("#btn-profile-club").click();
  await page.waitForTimeout(1500);
  check((await page.locator(".club-row").count()) === 2, "and the board shows them both");

  // Rotating the code is the answer to one that got out.
  const before = invite;
  await page.locator("#btn-club-newcode").click();
  await page.waitForFunction(
    (old) => document.querySelector("#club-screen .account-code-value")?.textContent?.trim() !== old,
    before,
    { timeout: 20000, polling: 250 }
  ).catch(() => null);
  const rotated = await page.locator("#club-screen .account-code-value").textContent();
  check(rotated?.trim() !== before, `a new code replaces the old one (${rotated?.trim()})`);
  const stale = await fetch(`http://localhost:${RELAY}/api/clubs/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: before }),
  });
  check(stale.status !== 200, "and the old one stops working");

  // The owner puts them out, and their pointer goes with them.
  await page.locator(".club-row .friend-remove").first().click();
  await page.waitForFunction(() => document.querySelectorAll(".club-row").length === 1, null, {
    timeout: 20000,
    polling: 250,
  }).catch(() => null);
  check((await page.locator(".club-row").count()) === 1, "the owner can put somebody out");
  const orphan = await fetch(`http://localhost:${RELAY}/api/clubs/me`, {
    headers: { authorization: `Bearer ${recruit.token}` },
  }).then((r) => r.json());
  check(orphan.club === null, "and they are told they have no club");

  // Last one out closes it.
  await page.locator("#btn-club-leave").click();
  await page.waitForFunction(() => Boolean(document.querySelector("#club-name")), null, {
    timeout: 20000,
    polling: 250,
  }).catch(() => null);
  check(
    await page.locator("#club-name").isVisible().catch(() => false),
    "the last member out is back at the two doors"
  );

  await page.locator("#club-screen .select-back").click();
  await page.waitForTimeout(500);
  await page.locator("#profile-screen .select-back").click();
  await page.waitForTimeout(600);
}

console.log("\nrecovering onto another device");
{
  // A different page with nothing in its storage is the closest this can get
  // to a new phone, which is exactly the case recovery exists for.
  const fresh = await browser.newPage({ viewport: { width: 390, height: 780 }, hasTouch: true });
  fresh.on("pageerror", (e) => failures.push(`page error: ${e.message}`));
  await fresh.goto(`${BASE}?q=medium&intro=0`, { waitUntil: "load" });
  await fresh.waitForTimeout(2500);
  await fresh.locator("#btn-title-profile").click();
  await fresh.waitForTimeout(500);
  await fresh.locator("#btn-profile-restore").click();
  await fresh.waitForTimeout(400);
  await fresh.locator("#restore-id").fill(code?.trim() ?? "");
  await fresh.locator("#restore-code").fill(recovery ?? "");
  await fresh.locator("#btn-restore").click();

  const issued = await fresh
    .waitForFunction(() => document.querySelector(".recovery-code")?.textContent?.trim() || null, null, {
      timeout: 20000,
      polling: 250,
    })
    .then((h) => h.jsonValue())
    .catch(() => null);
  check(Boolean(issued), "the account came back onto a phone that never had it");
  check(issued !== recovery, "and the spent code was replaced with a new one");
  await fresh.locator("#btn-recovery-done").click();
  await fresh.waitForTimeout(600);
  const name = await fresh.locator("#btn-title-profile").textContent().catch(() => null);
  const back = await fresh.locator(".account-code-value").textContent().catch(() => null);
  check(back?.trim() === code?.trim(), `the same player, not a new one (${back?.trim()})`);
  void name;

  // …and the phone it was recovered away from is now signed out.
  await page.reload({ waitUntil: "load" });
  await page.waitForTimeout(3000);
  await page.locator("#btn-title-profile").click();
  await page.waitForTimeout(1500);
  check(
    await page.locator("#profile-name").isVisible().catch(() => false),
    "the old device is signed out, as recovery is meant to do"
  );
  await fresh.close();
}

await browser.close();

if (failures.length === 0) {
  console.log("\nall good");
} else {
  console.log(`\n${failures.length} failed:`);
  for (const f of failures) console.log(` - ${f}`);
  process.exit(1);
}
