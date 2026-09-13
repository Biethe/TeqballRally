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
not after discovering a problem. Currently 10007 / 0.1.3.

## Online play

Host-authoritative with client-side prediction: one peer runs the whole match
and sends a full snapshot at 30 Hz, the other sends controls and renders what it
is told. `reframe` in `src/net/protocol.ts` is the single place the guest's
mirrored world lives. The README's "Online play" section is long and worth
reading before touching any of it.

**`PROTOCOL_VERSION` (currently 4) must match between both clients and the
relay**, which refuses to seat peers on different versions. Bumping it means
every phone needs the new build, and the relay needs redeploying — the two
halves always ship together.

Two clocks are not one, and conflating them caused most of the guest's visual
bugs: the simulation steps at a fixed `SIM_DT` with its frame delta capped,
while Babylon advances animations on the render loop. Anything that measures a
clip in simulation ticks has to be corrected from the clip's real progress.

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
