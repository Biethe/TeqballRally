# TeqRally

TeqRally is a browser-based 3D teqball game built with Babylon.js, TypeScript,
and Vite. Play solo against the CPU, learn in Practice, compete in a cup or
league, or share the court locally with a second player.

## Run locally

```bash
npm install
npm run dev                 # open the printed URL
npm run dev -- --host      # make the dev build reachable from a phone
npm run build              # production files in dist/
```

The game supports keyboard, touch, and Gamepad API controllers, and plays
either way up on a phone.

| Action | Keyboard | Gamepad | Touch (landscape) | Touch (portrait) |
| --- | --- | --- | --- | --- |
| Move | WASD or arrows | Left stick | Move stick | Tap where to stand |
| Aim | WASD or arrows | Left stick | Move stick | Direction of the gesture |
| Strike / serve | Space or Enter | A / Cross | STRIKE | Swipe |
| Make a reception | K | B / Circle | RECEPTION | Press and hold |
| Pause | Escape | Start / Options | Pause button | Pause button |

Portrait has no room for a stick and two buttons, so the whole screen becomes
the controller instead — a tap places the player, a swipe kicks in the
direction it was drawn, and a press held in place is a reception aimed by which
side of the screen it was made on. Both layouts feed the same input state, and
turning the phone switches between them mid-rally.

While a ball is dropping toward you and the touch is still yours to choose,
time eases down to half speed (`APPROACH_SLOWDOWN` in `src/config.ts`). It is
the whole simulation that slows, never the ball alone — characters, animation
and the timing gauge have to stay in step with it — and never in versus, where
one peer bending time would simply be playing a different match.

## Checks

```bash
npm run typecheck    # tsc --noEmit
npm run lint         # ESLint (type-aware)
npm test             # Vitest unit tests
npm run check        # all three
```

The unit tests in `tests/` cover the pure gameplay maths — ball physics and
trajectory solving, clip timing, character traits, and the AI presets. They run
in Node in under a second and need no browser. `tests/config.test.ts` also
parses `Animation.txt` and fails if the frame numbers in `src/config.ts` drift
away from it.

GitHub Actions runs all four steps (typecheck, lint, test, build) on every push
to `main` and every pull request.

## Browser test helpers

Anything that needs a real scene — asset loading, rendering, the match loop —
is driven through headless Chromium instead. Start a server on port 5199, then
run:

```bash
npm run dev -- --port 5199
node scripts/simulate.mjs 60      # headless match, logs state each second
node scripts/screenshot.mjs       # screenshots of the menus and a match
```

To smoke-test a production build end to end (this is the check that catches a
broken asset pipeline — the wrong loader import still typechecks and builds):

```bash
npm run build
npm run preview -- --port 5199 --strictPort
node scripts/verify-build.mjs
node scripts/verify-portrait.mjs   # the phone-upright control scheme
```

`?ts=8` speeds up simulation time. `?q=medium|high` forces a graphics tier for
the session, overriding both the remembered choice and auto-detection. `?q=low`
and `?light=1` still parse, and now resolve to `medium`.

## Phone layout

`scripts/ui-shots.mjs` captures every screen at the dimensions of the devices
this is played on and reports layout defects, which is how the landscape menus
were found to be unusable — the back button sat above the viewport and the last
two options below it.

```bash
npm run build && npm run preview -- --port 5199 --strictPort
node scripts/ui-shots.mjs     # screenshots in /tmp/ui, problems on stdout
```

It checks five things a screenshot alone will not tell you: controls outside
the viewport, tap targets under 44px, controls covered by something drawn over
them, panels overlapping each other, and text clipped mid-line. The last two
matter because a `pointer-events: none` overlay passes a hit test while still
visually burying the control underneath.

Landscape phones are the tight case — roughly 360px of height for what was
laid out expecting 430. `@media (max-height: 500px)` in `src/style.css`
compresses the vertical rhythm rather than scaling everything down, since
proportional shrinking keeps the same overflow at a smaller size.

The look is a lit arena rather than a dark utility screen: floodlit blue,
teqball's vermilion for anything that starts a match, and chunky bordered
panels. Every raised control sits on a flat colour lip (`--lip`) and drops
onto it when pressed, which is what reads as a button on a phone — a
one-pixel border and a hover state say nothing to a finger. One rule carries
the whole palette: warm means "do this", everything else is cool, so the
action on a screen is never ambiguous.

## Graphics quality

`src/quality.ts` defines two tiers, picked automatically on first launch from
`navigator.deviceMemory`, core count and whether the device is touch, then
overridable from the in-game SETTINGS menu and remembered in `localStorage`.
Applying a tier reloads the page — the engine's MSAA is fixed when the WebGL
context is created.

| | Pixel ratio cap | MSAA | Shadow map | Venue backdrop |
| --- | --- | --- | --- | --- |
| MEDIUM | 1.0 | off | 1024 | loaded |
| HIGH | 2.0 | on | 1024 | loaded |

There was a third tier below these. LOW dropped the venue backdrop to save a
1-5 MB download, which meant the venue a player had chosen did not appear — too
high a price for the framerate it bought. A stored or requested `low` now
resolves to `medium`.

The match simulates at a fixed 60 Hz regardless of display rate (`SIM_DT` in
`src/main.ts`), so a 30fps phone and a 120fps phone play the same game. Presses
are latched between simulation steps — see `latchInput` in `src/input.ts`.

## Venues

A venue is a backdrop model plus a procedural court that suits it, defined in
`src/venue.ts` and picked from SETTINGS → VENUE (`?venue=` overrides it for a
session). There are four: the indoor sports hall, and three outdoor grounds.

Nothing in a venue touches gameplay. The bounds players move inside
(`COURT.minX`, `maxX`, `maxZ`) and `GROUND_Y` are the same everywhere, which is
what lets it stay a local choice: two peers online can be looking at a
basketball hall and a football pitch and still run the same simulation. Only
the floor, the line colours, the boards and the sky change.

The outdoor courts set `surface: "venue"`, meaning the model's own blacktop,
grass or hard court is what the players stand on and only the teqball lines are
drawn over it. That is what makes them look like three places rather than one
court with three wallpapers — and when the tier skips the backdrop, the court
falls back to painting its own floor in the venue's colour, so LOW still gets
green grass or blue hard court for no download at all.

### Set dressing

The venue models are empty sports grounds. What makes one look like a match is
built in `src/environment.ts` from a palette in the venue preset — a ring of
lit sponsor boards around the court, a crowd standing behind it, corner flags —
because a real teqball court sits inside exactly that.

The board ring is procedural and costs nothing to ship: panels are merged into
one mesh per colour, so a 72-panel ring around the sports hall's ellipse is
three draw calls.

The crowd is `assets/models/Crowd/Crowd.glb` — 19 standing figures, 1,389
triangles each, 0.19 MB. Every figure is thin instanced, so a crowd is one draw
call per distinct figure rather than one per person: 65 people on the
basketball court cost 14 calls and 89k triangles.

Three things that pass a build and fail on screen, all found by looking:

- **Spectators are sized against the players, not against life.**
  `CHARACTER_SCALE` puts a character at about 1.45 m in an otherwise 1:1 world,
  so a realistic 1.75 m spectator stands a head taller than everyone on court.
- **One scale for the whole crowd, from the median figure.** Normalising each
  figure to the same bounding-box height shrinks exactly the people with their
  arms up — which, in a cheering pack, is most of them.
- **Recentre each figure on its own footprint, not just the floor.** The source
  pack is one grandstand and every figure carries the seat it was exported at.
  `MergeMeshes` bakes world matrices into vertices, so that offset survives
  inside the geometry, and a thin instance placed at the touchline lands at
  touchline-plus-seat. It scattered a third of the crowd across the pitch, and
  it is invisible from the play camera — `TOP=1 node scripts/venue-shots.mjs`
  is what showed it.

The crowd moves. `src/crowd.ts` rocks everyone on the spot during a rally and
jumps the whole stand when a point lands, listening to the match's own
`point-awarded` and `serve-committed` events rather than being told by every
caller that starts a match.

The animation is in the instance transforms, because a thin instance cannot be
skinned — it is a matrix sharing one skeleton-less mesh with every other copy.
That suits the material: the figures are already posed mid-cheer with their
arms up, so a vertical hop reads as celebration without a single new pose. A
matrix keeps its translation at indices 12, 13 and 14 of its sixteen floats,
so a person costs three writes a frame and the whole crowd is a rounding error.
It runs on wall-clock time outside the simulation — it is scenery, it must not
consume simulation steps, and it should keep moving under a menu.

Seated figures fill the benches the outdoor models already contain. Their
positions are measured out of the model rather than guessed: eight benches,
four a side, seat surface 0.31 m up. Those are the ten figures the standing
crowd throws away, so they cost nothing extra.

`tiers` builds a bowl of bleachers and is written and working, but no venue
uses it. The indoor hall's seating is modelled as concentric rings with no
per-seat geometry, so there is nothing to read a rake off, and every guess at
one put people through a wall or out on the grass. It needs the bowl's real
first-row radius and rise — a measurement, not another guess. Until then the
hall gets a courtside row inside the ring like the outdoor grounds.

The whole lot rides with the backdrop and is skipped on the tier that skips it.

#### Where the crowd came from

A purchased pack (3DExport, Basic Licence). Preparing it was four steps, none
of which are in the repository because the sources are 20x the size of the
result:

1. One placement extracted per distinct figure — the pack is 187 seats drawn
   from 29 people.
2. The 10 figures posed *sitting* dropped. They are seated on stadium seats
   that are not in the export, so on flat ground they look like they have
   fallen over. Height and the fraction of the body below mid-height separate
   them cleanly: seated figures are 127-139 cm and bottom-heavy, standing ones
   are 156-210 cm and top-heavy.
3. Colours assigned from the material *names*. The pack's own `.mtl` is 0.8
   grey everywhere with texture paths to a drive that does not exist, so which
   body part a material belongs to — hair, head, eyes, skin, clothes — is the
   only usable colour information in it. At the size a spectator is on screen,
   that plus a per-figure palette is enough.
4. `gltfpack -si 0.10 -cc -km -kn`: 9,222 triangles per figure down to 1,389,
   6.97 MB down to 0.28 MB for all 29.

The pose is recorded in the node name (`stand_`/`sit_`) because nothing else in
the file records it, and the loader finds it by walking *up* the parent chain:
the compression pass nests a generated `node0` between the named node and its
meshes, so a figure's immediate parent is anonymous.

At load, each figure's five materials are baked to vertex colours and merged,
so a person is one mesh with one material and can be instanced.

**The licence constrains how this ships, not whether.** It permits commercial
use in one product, royalty-free, up to 250,000 downloads. It also forbids
distributing the model "in a file format that is usable by any 3D
application" — and a `.glb` in an APK, or served from a web host, is exactly
that. Two consequences worth keeping in mind:

- **Do not make this repository public while `Crowd.glb` or `Props.glb` is in
  it.** A Shipaton submission asking for a repo link is the obvious way that
  happens by accident. The scenery props are purchased packs under the same
  kind of terms; their source files are deliberately kept out of the repo, and
  `scripts/props/` holds the recipe rather than the ingredients.
- Baking the crowd into the venue backdrop as merged static geometry is the
  stronger position for a shipped build, since it leaves no separable figure to
  extract. It costs the instancing — 65 people become 65 copies of the
  geometry — so it is a trade to make deliberately, not a default.

### Surroundings

The arena models are a fenced site with sky beyond the fence, which reads as a
diorama however good the court is. `src/surroundings.ts` builds the world each
one stands in — a city block, parkland, a beach — procedurally, so it costs no
download.

Realism at this budget is not detail, which a phone cannot afford and nobody
can see past a fence anyway. It comes from three things:

- **Silhouette and depth** — buildings at varying heights and distances, trees
  at varying scales, a horizon that recedes.
- **Haze** — exponential fog toward the horizon colour. This is most of what
  makes distance read as distance, and it hides the edge of the built world.
- **A sky with a gradient in it.** A flat clear colour is the most
  diorama-like thing in a scene; a graded dome is one unlit mesh.

Surfaces are tiled photographs rather than flat colours: `assets/textures/` —
eight 512x512 WebP tiles, 576 KB for the set. `Tile` in `src/venue.ts` gives
each one a name and **how much world one repeat covers**, and that number
matters as much as the image. Too large and the ground smears; too small and
it shimmers into noise at distance. The first pass put brick at 8 m a repeat
and the bricks came out a metre tall.

A texture also has to take the diffuse *colour* to white when it is applied —
`diffuseColor` multiplies the texture, so leaving the flat fallback colour in
place tints every photograph toward it. The flat colours stay as the fallback
for a venue with no tile.

Three of the eight arrived with measurable edge discontinuities and only one
of those — the water — had a seam you could actually see when tiled 2x2.
Brick, concrete and marble measured worse and looked fine. Measure, then look:
the metric flags contrast at the edge, which is not the same thing as a seam.
The water is mirrored in one axis, which wraps by construction and is
invisible on ripples that have no direction.

Two things it got wrong first, both worth keeping in mind for anything else
placed in the world:

- The world ground has to sit below everything the *venue* owns, not just
  below its court. The arena models stand on a foundation slab whose base is
  0.6 m under the playing surface, so a ground plane tucked 6 cm under the
  court drew straight over the top of it and turned every venue into the same
  sheet of grey. `WORLD_Y` is that height, and **everything outside the fence
  has to be placed on it** — the first row of parked cars was placed at court
  height and hovered a metre off the road.
- A vertex colour multiplies a StandardMaterial's **diffuse**, not its
  emissive. An unlit dome with white emissive comes out flat, and with black
  emissive comes out black; the gradient has to ride on diffuse.

### Scenery props

The boxes and sphere-trees above read as a world at a hundred metres and as a
diorama at thirty. `assets/models/Props/Props.glb` is 50 modelled props —
20 houses, 14 trees, 8 cars, 6 palms, 2 shrubs — in 0.45 MB, one material and
no textures at all. `src/props.ts` loads them; `src/surroundings.ts` places
them. A streetball court now stands in a neighbourhood, a pitch in a wood, a
hard court under palms.

They are cheap for three reasons, and the third is the one that is easy to get
wrong:

- **The colour is baked into the vertices.** All four packs colour themselves
  from one atlas of flat palette swatches — every window, wheel and door in
  them is geometry, not texture detail — so the atlas is sampled per vertex at
  build time and thrown away. That also killed a rainbow-striping artefact:
  aggressive simplification drags UVs across neighbouring swatches, and with
  no UVs there is nothing to drag.
- **They are decimated at build time.** Houses arrive at 3-8k triangles and
  ship at ~1k. `gltfpack -si` alone reduces these models by 5%: they are
  faceted, so every edge is an attribute seam, and only `-sa` will collapse
  one.
- **A draw call is per model, not per copy.** `Scatter.models` is a draw-call
  budget: twenty houses placed from twenty models cost twenty calls and buy
  nothing visible at forty metres, where six models at varied scale and
  rotation read the same. The first pass placed 56 props from 42 models and
  paid 42 calls for it.

Three that cost real time:

- **Quantized positions do not survive `bakeCurrentTransformIntoVertices`.**
  `getVerticesData` hands back the raw integers, the bake transforms *those*,
  and the props came out as 1 cm slabs. The file is packed `-vpf` for that
  reason.
- **Baking does not refresh the bounding box.** It stays as the loader built
  it from the file's accessor bounds, so a height read straight after a bake
  is the height from before it, and every prop gets scaled by the wrong
  number.
- **A PBR material can hide bad vertex colours**, which makes it a bad
  baseline. Half an hour went into chasing "broken normals" that were the
  pack's own near-black roofs, invisible under the glTF material that was not
  showing the vertex colours at all.

Rebuilding the file needs the source packs, which are not in the repo: see
`scripts/props/pack-props.sh`, which documents the whole pipeline and the
reason for every flag in it.

### The establishing shot

An offline match opens on the venue rather than on the table: `src/intro.ts`
swings the camera in from wide and high over about three and a half seconds,
under a broadcast card naming the venue and the two players. Any press skips
it. The simulation is held while it runs, because the CPU is perfectly happy
to serve during a camera move.

Online matches do not get one. Holding the local simulation while the other
peer keeps playing is a forfeited point, and there is no reason for the two
phones to agree about a camera.

The shot is plain numbers rather than Babylon vectors so `tests/intro.test.ts`
can assert the parts that fail silently: that it ends exactly on the live play
camera, that it never dips below the floor, and that a bounded sweep stays
inside its bounds. Each venue can name its own `sweep`, and the sports hall
needs one — it is enclosed, so pulling back leaves the bowl and lifting hits
the roof trusses. Its shot stays at the play camera's own height, which is the
one line through the hall the game already proves is clear.

### Preparing a backdrop model

The three outdoor arenas arrived at ~8 MB each, split into 400-720 meshes over
15-21 materials. Draw calls are what a backdrop costs on a phone — not
triangles — and 723 of them is more than ten times the rest of the scene.

```bash
scripts/pack-arena.sh raw/Basketball.glb assets/models/Arena/Basketball.glb
```

That is `gltfpack -cc -mm -km`, and the flags are explained in the script. It
takes each arena to ~1.2 MB in one mesh per material:

| | before | after |
| --- | --- | --- |
| Basketball | 8.10 MB, 723 meshes | 1.22 MB, 21 |
| Soccer | 9.02 MB, 685 meshes | 1.45 MB, 15 |
| Tennis | 6.96 MB, 400 meshes | 1.10 MB, 16 |

`mergeByMaterial` in `src/scene.ts` does the same merge at runtime for models
that arrive unpacked — the sports hall goes 86 → 41 that way. It skips any mesh
that has instances: `MergeMeshes` disposes the sources it consumed, and
disposing a mesh takes its instances with it, so merging a model whose exporter
shared one mesh across many nodes would silently delete every bench but the
first. `-mm` above exists to avoid handing it that shape in the first place.

```bash
npm run build && npm run preview -- --port 5199 --strictPort
node scripts/venue-shots.mjs             # draw calls per frame + a screenshot each
node scripts/venue-shots.mjs --no-merge  # the same without merging, to compare
QUALITY=low node scripts/venue-shots.mjs # the no-backdrop fallback
```

`venue-shots.mjs` counts real draw calls by wrapping the engine's draw entry
points for a couple of seconds, because counting meshes misleads in both
directions: one mesh with several submeshes is several calls, and a hundred
instanced copies are one. Comparing merged against `--no-merge` is also the
only way to know the merge draws the same picture — on the basketball court it
took 723 calls to 21 with every differing pixel belonging to the characters and
the HUD.

## Texture budget

Character textures are capped at 1024x1024. This matters more than file size:
a 2048x2048 texture is about 1 MB as WebP but ~16 MB of RGBA once decoded (~21 MB
with mipmaps), and each character carries eleven of them. The cap took each
character from ~185 MB of decoded texture memory to ~46 MB.

`scripts/shrink_textures.py` applies the cap (needs `pip install Pillow`):

```bash
python3 scripts/shrink_textures.py --dry-run assets/models/characters/*.glb
python3 scripts/shrink_textures.py --max 1024 assets/models/characters/*.glb
```

It rewrites the GLB in place, moving the EXT_meshopt_compression block as one
piece so the compressed geometry is never reinterpreted. Re-run
`scripts/verify-build.mjs` afterwards — it loads the models in a real browser,
which is the only thing that proves a rewritten GLB still works.

Music must be MP3: a 30-second 24-bit stereo WAV is 7.9 MB against 0.5 MB at
128 kbps.

## Online play

The netcode is **host-authoritative with client-side prediction**. One peer
runs the whole match — both characters, the ball, the rules — and sends a full
snapshot at 20 Hz; the other sends its controls every step and applies what
comes back. The guest predicts its own character locally so its stick still
feels immediate, and `reconcile` in `src/net/reconcile.ts` eases that
prediction back onto each snapshot, snapping only when the error is large
enough that easing would be visible as sliding.

An earlier design let the striking peer roll its own dice and send the
resulting ball state, with authority passing back and forth. It was elegant and
it did not work: both peers were running complete independent matches, so
everything not carried by a strike message — where the *other* player was
standing, which clip they were playing — drifted apart within a rally.
`snap` carries positions, velocities and clip names for both sides precisely
because guessing at any of them is what broke.

The guest's world is mirrored so both players see themselves on the near side;
`reframe` in `src/net/protocol.ts` rotates every message 180° about the
vertical axis on the way in and out, and swaps the two seats with it.

```bash
npm run relay        # PORT=8787, health check on /healthz
```

### Deploying with only a phone

Everything below can be done from a mobile browser.

1. **Host the relay.** Sign in to a container host with GitHub, create a service
   from this repository, and let `render.yaml` configure it. Wait for the
   `wss://…` URL, and confirm `https://…/healthz` answers `{"ok":true}`.
2. **Tell the app where it is.** GitHub → Settings → Secrets and variables →
   Actions → Variables → new repository variable `VITE_RELAY_URL`, set to the
   `wss://` URL. Or skip this and type the URL each time in step 3.
3. **Build.** GitHub → Actions → *Android APK* → **Run workflow**, optionally
   pasting the relay URL. The run summary prints which relay was baked in.
4. **Install.** Download the `teqrally-debug-apk` artifact from the finished
   run, unzip, open the APK. Repeat on the second phone.

A build with no relay configured still installs and plays; online is shown as
unavailable rather than failing partway through a lobby.

### Where the relay runs

A Firebase project is also a Google Cloud project, so the relay belongs on
**Cloud Run** in the same project as Hosting — one console, one bill, and
WebSockets over TLS with no certificate work.

Two things not to try:

- **Firebase Hosting cannot proxy WebSockets.** A `rewrite` to Cloud Run works
  for ordinary requests but not for the upgrade, so the game connects straight
  to the Cloud Run URL rather than through `yourapp.web.app`.
- **Realtime Database is the wrong transport for match data.** It is a fine
  lobby, but 20 Hz of position updates per player is not what it is priced or
  tuned for, and it adds a hop the relay does not.

```bash
gcloud run deploy teqopen-relay \
  --source server \
  --region europe-west1 \
  --allow-unauthenticated \
  --max-instances 1 \
  --min-instances 1 \
  --timeout 3600
```

`--max-instances 1` is **required, not tuning**: rooms live in the relay's
memory, so two players routed to different instances would sit in separate
rooms with the same code and never see each other. Sharing room state (Redis,
or Realtime Database) is what would lift that cap.

`--min-instances 1` avoids a cold start on the first connection, and
`--timeout 3600` stops Cloud Run cutting a long WebSocket at its default.

Then point the game at the deployed URL — builds cannot discover it, because a
packaged app's own origin is `https://localhost`:

```bash
VITE_RELAY_URL=wss://teqopen-relay-xxxxx.europe-west1.run.app npm run build
```

`src/net/endpoint.ts` falls back to the page's own host on port 8787, which is
correct for `npm run dev:lan` and deliberately wrong for a packaged build that
forgot the variable — `looksReachable` detects that case so online play can be
shown as unavailable instead of failing at the end of a lobby flow.

`server/relay.mjs` knows only about rooms and seats and forwards every other
frame verbatim — no game state lives there, so it cannot disagree with the
clients and can be restarted mid-match. A WebSocket relay rather than WebRTC
because a DataChannel needs signalling plus a TURN fallback, which is not where
a deadline should go.

`tests/relay.test.ts` and `tests/rally.test.ts` run the real server and two real
sockets, and assert that a rally's worth of frames leaves both peers agreeing
about the score and each player on their own side of their own table.

```bash
npm run build && npm run preview -- --port 5199 --strictPort
npm run relay
node scripts/verify-online-match.mjs   # two headless clients play a real match
```

That one is worth the wall-clock: it caught a guest whose opponent never moved,
and again a guest whose opponent moved but never animated, both of which
typecheck and pass every unit test.

## Testing on a phone

**Quickest — no Android tooling at all.** The game is a web app, so a phone on
the same Wi-Fi can just open the dev server:

```bash
npm run dev:lan          # prints a Network: http://192.168.x.x:5173 URL
```

Open that URL on the phone. This exercises the real GPU, the real touch
controls and the real device tier detection, and it hot-reloads on save. It is
the fastest way to check how the game actually feels.

The one thing it does not test is the WebView: Chrome on Android and the
WebView the packaged app runs in are not always the same engine version. For
anything performance- or WebGL-sensitive, confirm in a real build too.

### Android build

```bash
npm run android:apk      # build, sync, then assembleDebug
```

The APK lands at `android/app/build/outputs/apk/debug/app-debug.apk`. Copy it
to the phone and install, or `adb install -r <path>`.

Requires the Android SDK (platform 35 and build-tools) plus JDK 21.
`npm run android:open` opens the project in Android Studio, which will offer to
install anything missing — the easiest first-time route.

### Live reload inside the real WebView

Best of both: the packaged app, but loading from the dev server so edits appear
without a rebuild.

```bash
npm run dev:lan
CAP_SERVER_URL=http://192.168.x.x:5173 npx cap sync android
npm run android:apk
```

Unset `CAP_SERVER_URL` and re-sync before building anything you intend to ship,
or the app will point at a dev machine that is not there.

Debug builds allow cleartext HTTP and WebSockets to the local network
(`android/app/src/debug/res/xml/network_security_config.xml`) so the device can
reach the dev server and a relay running on a laptop. Release builds refuse
cleartext, so a shipped app must use `https://` and `wss://`.

## Deploy

TeqRally is a static site; Firebase Hosting serves the built `dist/` folder.

```bash
npx firebase-tools login
npm run build
npx firebase-tools deploy --only hosting --project YOUR_FIREBASE_PROJECT_ID
```

## Project notes

- `src/scene.ts` — Babylon scene, court, table, backdrop, and asset loading.
- `src/venue.ts` — venue presets: which backdrop, which court palette.
- `src/character.ts` — character rigs, animation timing, and contact offsets.
- `src/ball.ts` / `src/match.ts` — ball physics, rallies, scoring, sets, and replays.
- `src/ai.ts` / `src/input.ts` — CPU behavior and keyboard, touch, and gamepad input.
- `src/ui.ts` / `src/main.ts` — menus, practice flow, cameras, and application flow.
- `assets/` — compressed GLB models, audio, and the local Meshopt decoder.
- `tests/` — Vitest unit tests for the pure gameplay maths.
- `scripts/` — headless-Chromium helpers for the parts unit tests cannot reach.

Babylon is emitted as its own `babylon-*.js` chunk, so shipping game code does
not invalidate the ~1.8 MB engine a returning player already has cached. Only
the statically reached part of the engine goes in there — Babylon's shaders and
texture loaders stay in the lazy chunks Rollup already splits them into.

The models use Meshopt geometry/animation compression and WebP textures so the
hosted game downloads quickly while keeping the original rigs and animation
groups.

## Codex and GPT-5.6

I built and tested TeqRally in Codex with GPT-5.6. Codex helped implement and
debug the animation, physics, match rules, AI, input, replay, mobile, and
hosting work. Product decisions and playtesting remained mine.
