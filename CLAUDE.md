# Working on TeqRallly

A browser-based 3D teqball game (Babylon.js, TypeScript, Vite), packaged for
Android with Capacitor, shipping to a Google Play closed test. The server is a
match relay and accounts API in one Node process on Cloud Run.

**`README.md` is the living doc.** It explains why things are the way they are,
and it is kept current — when you change behaviour it describes, change it too.
This file is the other half: the things that are not obvious from the code and
that cost a session to rediscover.

## Before you finish anything

```bash
npm run check      # typecheck + lint + ~1050 tests. Must be green.
```

Tests are not decoration here. Most of the hard bugs in this project were found
by writing a test that reproduced them, and several were *caused* by code that
typechecked fine. If you fix something subtle, pin it.

## Traps that have already bitten

**`publicDir` is `assets`, not `public`.** Anything the page requests by URL
must live under `assets/`. Files in `public/` never reach the build at all.

**The art is not in the repo.** `assets/` is gitignored (bar fonts, the mesh
decoder and `assets/figma/icon.png`) and comes from a private bundle via
`npm run assets:fetch`. **The bundle is a snapshot**: a file added to `assets/`
after the last pack is missing from every build made anywhere but the machine
that added it, and `assets.manifest.json` lists what is actually in there.

**Anything configured only on this machine will be silently wrong in CI.** This
has happened three times: the relay URL, the brand icon, and the RevenueCat key.
Local values live in `.env` (gitignored); CI needs the same thing as a GitHub
secret *and* a line in the workflow passing it. When adding a new build-time
variable, add the guard that fails the build without it — `.github/workflows/android.yml`
already does this for `VITE_ASSET_KEY` and `VITE_REVENUECAT_KEY`, and those
guards are the only reason a bad build stops rather than ships.

**`server/rules.mjs` is generated.** Source of truth is `src/rules.ts` and what
it re-exports. Never hand-edit it; run `npm run rules`. Anything re-exported
there must be pure — no `localStorage`, no `document`.

**The server's types are hand-written `.d.mts` files.** `server/*.mjs` is plain
ESM; `server/*.d.mts` describes it for the TypeScript tests. Add a server export
and you must add it there too, or `npm run check` fails in a way that looks like
the export does not exist.

**A Play `versionCode` is spent the moment Play accepts an upload**, even for a
release you halt or discard. Bump `android/app/build.gradle` *before* building,
not after discovering a problem. Currently 10008 / 0.1.3.

**The browser harnesses need `npm run build:harness`, not `npm run build`.**
They drive the game through `window.__teq*`, and a release build does not
carry those handles — they are a debugger attached to a live match, which is a
cheat console in a shipped game. `build:harness` is the same production build
with `VITE_HARNESS=1` and the handles left in. Run one against a plain build
and it does not fail: it sits there waiting five minutes for `__teq` to appear.
`npm run verify:release` is the other half, and checks the shipped bundle boots
*without* them.

## Online play

Host-authoritative with client-side prediction: one peer runs the whole match
and sends a full snapshot at 30 Hz, the other sends controls. The guest does not
render the ball or the clips from snapshots: the host sends each *decision*
(`launch`, `clip`) and the guest flies and animates from them on its own clock
— `src/net/guestball.ts`. Snapshots carry bodies, score and phase, and check the
flown ball. `reframe` in `src/net/protocol.ts` is the single place the guest's
mirrored world lives. The README's "Online play" section is long and worth
reading before touching any of it.

**Every host-side change to the ball during play must be published** —
`publishShot` for a touch decided ahead, `noteBallChanged` for anything decided
as it happens. Miss one and the guest flies a flight the host never had until a
snapshot catches it; `the guest plays the host's decisions` in
`tests/follower.test.ts` holds re-anchors at zero and fails when that happens.

**`PROTOCOL_VERSION` (currently 6) must match between both clients and the
relay**, which refuses to seat peers on different versions. Bumping it means
every phone needs the new build, and the relay needs redeploying — the two
halves always ship together.

There is one clock. A match's animations are *placed* on simulation ticks
(`src/animclock.ts`, `Character.useSimClock`), not played by Babylon — two clocks
caused most of the guest's visual bugs. Never add a match clip that runs on the
render loop, and never time anything in a match against wall time.

**The unit tests never touch the real socket layer.** Every fake connection
passes messages through untouched, and `NetConnection.send` does not — it once
stamped the send tick over every decision's own, which broke every kick on real
phones while all ~1100 tests passed. "Re-anchors" in the connection stats should
be zero; if they are not, reproduce with two real clients against
`npm run relay` before trusting a green test run.

The faster device hosts (`chooseAuthority`, `perf` on `setup`), and a guest draws
the host's past from a measured buffer at the host's rate (`PlaybackBuffer`).
The connection stats overlay — frame rate, simulation speed, rtt, jitter, the
guest's clock gap and its re-anchor count — is what says whether a match looks
wrong because of the link or because a device cannot keep up. It used to be a
toggle in the gameplay settings and is not any more: it is a diagnostic a
player has no use for and cannot act on. A build carries it or does not, and
the build that does is `npm run build:harness` (`EXPOSE_INTERNALS`). To judge
an online match on a real phone, sync *that* build to the device.

## Purchases

**Nothing is granted on the client's word.** Play takes the money, RevenueCat
verifies it, RevenueCat calls `POST /api/revenuecat`, and the server grants from
`src/catalogue.ts` — shared with the client through `src/rules.ts` so neither
end decides alone. The webhook authenticates with `REVENUECAT_WEBHOOK_SECRET`
and is idempotent by event id. Do not add a path where the device tells the
server what it bought; that is what was there before and it was a hole.

In-app products cannot be tested from a sideloaded build. Play matches the
package name and signing certificate against the published app, so a debug APK
gets no products however correct the console is.

## Deploying

```bash
REVENUECAT_WEBHOOK_SECRET='…' ./server/deploy.sh    # Cloud Run, europe-west9
```

Releases are built by GitHub Actions, not locally, because the asset key and the
signing key are repository secrets. The workflow publishes the debug APK as a
GitHub Release and the signed AAB as a run **artifact** — different places, which
is confusing the first time.

Do not judge the service by `/healthz`; some networks intercept it. Use
`curl https://…/api/leaderboard`.

## Decisions already made

Do not relitigate these without asking:

- **No subscriptions.** Money buys the arena and coins; everything else is
  earned. See the README's economy section.
- **AI rivals never appear on the leaderboard.** They fill an empty quick-match
  queue (`src/rivals.ts`) and that is all. The leaderboard is where players
  measure themselves against each other and it stays real.
- **Quick match calls out to everybody online** rather than pairing two people
  who happen to be queued at the same instant, which for a game this size is
  nobody. A rival is the fallback, never the first answer.
- **What players can say to each other is a fixed list** (`src/emotes.ts`).
  Never a text field: a fixed catalogue is not user-generated content, and that
  is what keeps the feature clear of Play's moderation and reporting duties.
- **Online play is refused without a network**, rather than quietly becoming an
  AI match. A player with no signal knows they are offline.
- **The onboarding tour is interactive** (`src/tour.ts`), not a stack of cards.
  Every step is finished by doing the thing, never by pressing Next.

## House style

The code is commented densely and in prose, explaining *why* rather than what,
often naming the bug a piece of code exists to prevent. Match it. A comment that
restates the line below it is worse than none; a comment recording why an
obvious-looking simpler version does not work is the most valuable thing in the
file.
