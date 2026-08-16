
# World tuning guide

All knobs live in `src/config.ts` (block marked **world layout tuning**). Vite
hot-reloads on save, so tune with the game running.

**Coordinate system**: table centre = origin, x = table length axis (you are on
x < 0, facing +x), z = lateral (+z = your left), ground plane at `GROUND_Y`.

## Free camera

Press **F2 during a match**: WASD moves, mouse-drag looks, E/Q up/down, hold
Shift for speed. WASD steers the camera (not the player) while flying. Press F2
again to exit — the camera position/target are logged to the browser console so
you can copy them into code. While active it's available in the console as
`__freecam`.

Permanent camera placements:
- Match camera (follows play): `updateCamera()` in `src/match.ts` — `desired`
  is the position, `look` the aim point (both offset by `GROUND_Y`).
- Initial/menu camera: `createGameScene()` in `src/scene.ts`.

## Parameters

| What | Where | Notes |
|---|---|---|
| **Ground level** | `GROUND_Y` | THE master height. Physics ground, table, net, spawns, floor visuals and camera all follow it. Set it to the arena court floor height so physics matches what you see. |
| Player spawn | `SPAWN.x / z / lift` | Spawn/idle spot per side (mirrored for the AI). `lift` is a small extra y if a model's soles still sink. |
| Arena position | `ARENA.offsetX / offsetY / offsetZ` | Move the arena so its painted court centres on the table. `offsetY` raises/lowers the whole arena relative to y=0. |
| Arena size / rotation | `ARENA.span` / `ARENA.rotationY` | Longest side in metres / radians. |
| Table size | `TABLE.length / width / hCenter / hEnd / netTop` | The *real* table: physics and model scale together. |
| Table model nudge | `TABLE_VISUAL.scale / offsetX / offsetY / offsetZ` | Visual-only; offsets are relative to `GROUND_Y`. Keep small or the ball will bounce where the table isn't. |
| Player size | `CHARACTERS[…].height`, `CHARACTER_SCALE` | Per-player height and a global multiplier; gameplay proportions scale with it. |
| Player traits | `CHARACTERS[…]` | Per-player `strongFoot` (left/right/both), court `speed` (m/s), kick `power`, aim `precision` (>1 = tighter), and `backflips` (none / strong foot only / both feet). |
| Foot handedness | `FOOT_FACTOR` | Power/spray modifiers a footed player gets on strong- vs weak-foot clips (foot kicks, inner lobs, backflips, foot serves). |
| Procedural court | `COURT.floorHalfLen / floorHalfWid` | The dark-blue floor and boards (drawn at `GROUND_Y`). |
| Movement bounds | `COURT.minX / maxX / maxZ` | How far players can roam. |
| Touch rules | `MAX_TOUCHES` | Touches per possession. |
| Scoring | `WIN_SCORE` / `SETS_TO_WIN` | Points to win a set / sets to win the game (12 and 2 = best of 3). |
| Strike feel | `STRIKE_LEAD / POP_LEAD` (top of `src/match.ts`) | Nominal press-to-contact delay (used to pick the clip); the actual contact frame is planned inside `CONTACT_WINDOW`. |
| Contact planning | `CONTACT_WINDOW / LUNGE_MAX / CONTACT_SNAP` (top of `src/match.ts`) | The ball flies its natural path; the player lunges to meet it. Window of allowed contact times, max lunge glide distance, max final ball nudge onto the limb. |
| Reach assist | `REACH_ASSIST.radius / strength` | Soft magnetism: pushing the stick roughly toward the incoming ball bends the run onto its interception point. `strength: 0` disables it. |
| Serve aim | `serveClipForAim` (in `src/character.ts`) / `launchServe` (in `src/match.ts`) | Hold a direction before/while serving: aim left → right-foot serve, right → left-foot serve, centre → head serve. The 0.25 band threshold lives in `serveClipForAim`. |
| AI difficulty | `DIFFICULTIES` in `src/ai.ts` | easy/normal/hard presets: `speed` (fraction of the character's own speed), `aimError`, `reactionTime` (spent twice — once before the run starts, once before the touch), `misjudge` (metres of drop-point misread, the thing that loses it a ball), `popChance`, `maxPopTouches`. Friendly games pick one; competitions use normal, then hard for finals / the last league round. |

## Rules of thumb

- **Never** lift the floor or table visuals to meet the arena — set `GROUND_Y`
  (gameplay + visuals move together) or lower the arena with `ARENA.offsetY`.
- The arena moves as one piece; align its court to the table with the offsets,
  not the other way around.
