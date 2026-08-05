# TeqOpen

TeqOpen is a browser-based 3D teqball game built with Babylon.js, TypeScript,
and Vite. Play solo against the CPU, learn in Practice, compete in a cup or
league, or share the court locally with a second player.

## Run locally

```bash
npm install
npm run dev                 # open the printed URL
npm run dev -- --host      # make the dev build reachable from a phone
npm run build              # production files in dist/
```

The game supports keyboard, touch, and Gamepad API controllers. On a phone,
use landscape orientation for the full court.

| Action | Keyboard | Gamepad |
| --- | --- | --- |
| Move / aim | WASD or arrows | Left stick |
| Strike / serve | Space or Enter | A / Cross |
| Make a reception | K | B / Circle |
| Pause | Escape | Start / Options |

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
```

`?light=1` enables cheaper shadows and `?ts=8` speeds up simulation time.

## Deploy

TeqOpen is a static site; Firebase Hosting serves the built `dist/` folder.

```bash
npx firebase-tools login
npm run build
npx firebase-tools deploy --only hosting --project YOUR_FIREBASE_PROJECT_ID
```

## Project notes

- `src/scene.ts` — Babylon scene, court, table, arena, and asset loading.
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

I built and tested TeqOpen in Codex with GPT-5.6. Codex helped implement and
debug the animation, physics, match rules, AI, input, replay, mobile, and
hosting work. Product decisions and playtesting remained mine.
