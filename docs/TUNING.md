
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
| Player traits | `CHARACTERS[…]` | Per-player `strongFoot` (left/right/both), court `speed` (m/s), kick `power`, aim `precision` (>1 = tighter), `stamina`, `serve`, `agility`, `volley`, `weakFoot` (0-100) and `backflips` (none / strong foot only / both feet). **The roster is a ladder** — each entry unlocks later and must be plainly better overall than the one before it; `tests/config.test.ts` fails if that stops being true, or if a rung stops giving anything up. |
| Trait bars | `SPAN` / `RATING_FLOOR` / `RATING_CAP` in `src/ratings.ts` | What each 0-100 bar is measured against. Fixed bounds, not derived from the roster, so retuning a character does not move everybody else's numbers. The bar stops at 95: nobody is ever finished. |
| Levels | `withCareer` / `upgradeCost` / `XP_PER_LEVEL` / `MAX_LEVEL` in `src/progress.ts` | What a level buys and what it costs. Power and serve are deliberately untouched by levelling — they belong to the character. |
| Stamina | `EFFORT` in `src/match.ts`, `MIN_EFFORT` and `legs` in `src/character.ts` | How fast the legs empty, how fast they come back, and what being empty costs (mostly acceleration, a little top speed). |
| Supplies | `SUPPLIES` / `BOOST_CAP` in `src/supplies.ts` | The shop shelf. Each item's `boost` multiplies stamina/agility/precision; `power` is deliberately not for sale. |
| Coin economy | `PURSE` / `STAKE` in `src/league.ts`, `COINS_PER_TROPHY` in `src/progress.ts` | What a match pays, and what a trophy is worth at the exchange. |
| Foot handedness | `FOOT_FACTOR` | Power/spray modifiers a footed player gets on strong- vs weak-foot clips (foot kicks, inner lobs, backflips, foot serves). |
| Procedural court | `COURT.floorHalfLen / floorHalfWid` | The dark-blue floor and boards (drawn at `GROUND_Y`). |
| Movement bounds | `COURT.minX / maxX / maxZ` | How far players can roam. |
| Touch rules | `MAX_TOUCHES` | Touches per possession. Two touches in a row may never use the same part of the body; that rule is enforced when the clip is chosen (`avoid` in `chooseStrike` / `pickReceptionClip`), not as a foul afterwards. |
| Body parts | `PART_SETUP` in `src/config.ts` | What each limb does with a set-up: `rise` (how high the ball sits up — how much time before the next touch), `carry` (how far it can be placed) and `control` (how much of the placement survives a bad contact). This table is what makes chest/knee/foot a decision rather than a picture. |
| Reception zone | `RECEPTION_ZONE` in `src/config.ts` | The room a player has around a ball **coming at them**: `radius` is free movement, `soft` is the band the outward push fades across, `minPush` what is left of it at the far edge, `leash` the walk back for a player who is not steering. Soft on purpose — a player who means to leave still leaves. Keep `radius` below `PLAYER_REACH + LUNGE_MAX` — `tests/reception.test.ts` fails if moving freely inside the zone could put a reachable ball out of reach. |
| Reception aiming | `RECEPTION_STICK_DEADZONE` (top of `src/match.ts`) | The first touch is crafted: the automatic reception pops the ball toward the stick held at the moment of contact (a portrait tap takes precedence; below the deadzone a resting thumb aims nothing). The portrait seat never reads the stick — its axes carry swipe residue. While the locked run owns the feet the stick is idle anyway, so holding a direction during the carry is the player shaping the set-up. |
| Set-up leash | `RECEPTION_ZONE.hardCap` | The room around a ball you **set up yourself**, and a wall rather than a suggestion: outward movement is blocked at the edge, sideways is untouched, so you can circle the drop to choose a foot but cannot walk off your own ball. Landscape only — portrait steers by tapping, and a tap the game refuses reads as a dead control. Must stay under `PLAYER_REACH`. |
| Auto-run lock | `AUTO_RUN` in `src/config.ts` | Semi-assisted: while the ball is still far off the feet are the player's own; only inside `vicinity` of the drop spot does the run take over, and from there the stick is not listened to — overriding the run there was exactly how players walked past the ball. `arrive` is where the run releases and shifting the body becomes the player's decision again; `reengage` how far the anchor may move before the run picks back up. Landscape only. While locked, the reception takes the nearest side of the body (`forceNearest` in `pickReceptionClip`) — the standing was not chosen, so neither is the side. Keep `arrive` below `PLAYER_REACH` and `reengage` below `vicinity`. |
| Strike bands | `STRIKE_BANDS` in `src/character.ts` | How high a ball has to be, in body heights, for each way of striking it. The ladder reads upward in the order the shots happen: foot, then header, then **backflip above the head**. The flip used to sit below the header and, being offered first, took nearly every set-up ball — a flat bicycle kick from chest height. |
| Strike ceiling | `STRIKE_CEILING` in `src/character.ts` | How high a touch may be *planned* at. `normal` is anything played off the body, which has to wait for the ball to come down to it; `flip` is higher, because a bicycle kick is struck above the head and waiting is waiting for the shot to be gone. Do not raise `flip` past ~1.2 — `canTouch` measures from the chest, and the reach sphere closes. |
| Landscape kick | `KICK_INPUT` in `src/kickinput.ts` | One button, two answers: `tiers` is the speed each tap count asks for (what the power bar shows), `loftRamp` and `loftMax` the arc a hold builds. `hold` is where a press stops being a tap; `tapWindow` how long a tap sequence waits for another. A held press and the third tap commit on release with no wait at all, so the shot whose timing matters never pays the window. `loftMax` stays matched to `SWIPE_LOFT.high` — two ways of asking, not two games — and every launch is policed by the apex ceiling below. |
| Incoming pace | `PACE` in `src/touch.ts` | What a fast ball costs the next touch. `receive` ramps the reception's quality down from `from` to `full` pace (floor: a hard hit is a harder next ball, never a lost point). `volley` gates kicking it back directly, before any control touch: the character's `volley` trait sets the pace they take cleanly (`base + (volley − 0.6)·perPoint`), and past it the strike's quality ramps to the floor over `band` — where the spread makes the return almost never land. Mostly impossible, except for the characters built for it. Judged against the pace the ball was *struck* at (`struckPace`), not the velocity the table bounce has already damped. |
| Apex ceiling | `capLaunchApex` in `src/ball.ts`, applied in `src/match.ts` | No ball may climb higher than twice the striker's height (`GROUND_Y + 2·height`). Applied at every launch — strikes, serves and set-up pops alike — after the net-clearance solve, which can lengthen a flight past what was asked. When it binds, horizontal pace survives and the ball lands short. Ordinary shots stay under it; the widest arcs (full hold, steep upward swipe) are what it exists for. |
| Serve shape | `SERVE_CLEARANCE` in `src/config.ts` / `SERVE_ARC` in `src/match.ts` | Metres of air over the tape, which for a ball struck from behind the service line is what the serve's arc actually *is* — `solveLaunchClearingNet` only ever lengthens a flight. Pace shapes it too, or three different paces all get lengthened to the same arc and speed says nothing. The landing drifts toward the aimed sideline by what the server's traits allow — deterministic, so the skill is leaving a hand's width of inward aim; centre serves drift not at all, and neutral reproduces the old fixed serve exactly (`tests/serve.test.ts` holds both). |
| Touch quality | `QUALITY` / `BANDS` in `src/touch.ts` | How a contact is graded: the weights on height, reach and timing errors, the scale each is measured against, and the floor a grade cannot fall below (a poor touch is a harder next ball, never a lost point). |
| Landing deviation | `DEVIATION` / `landingDeviation` in `src/aim.ts` | Where a kick actually lands: the aim displaced by the contact's own geometry — never rolled. `along` shares the spread between over/under-carry (early contacts and full power carry long, late ones die short) and the across-squirt of a ball reached at stretch (toward the side it was reached on; a squared-up contact squirts not at all). Same shot, same landing — a miss is a lesson. The radius is still the old spread machinery (`spreadRadius` × contact quality), so power and precision cost/buy exactly what they did. |
| Portrait swipe | `SWIPE_BAND`, `SWIPE_PACE`, `SWIPE_LOFT` in `src/aim.ts` | Three independent dials. `SWIPE_PACE` is how hard the slowest and fastest swipes strike — steepness must never touch it. `SWIPE_LOFT` is the arc at each steep end, around the neutral ball — deliberately wide so the thumb's lift is felt, policed by the apex ceiling rather than squeezed back here. `SWIPE_BAND` is where a swipe stops being a sideways one and how forgiving that boundary is (`from` is low on purpose: a little lift is unmistakably upward). |
| Swipe depth | `SWIPE_DEPTH` in `src/aim.ts` | Where on the opponent's half a swipe lands, as a fraction of it. `base` is the middle; `fromLoft` and `fromPace` move it from there. Depth is **derived** from arc and pace, never dialled. The target is table-relative, so where the striker stands cannot decide whether the ball can land in. |
| Scoring | `WIN_SCORE` / `SETS_TO_WIN` | Points to win a set / sets to win the game (12 and 2 = best of 3). |
| Strike feel | `STRIKE_LEAD / POP_LEAD` (top of `src/match.ts`) | Nominal press-to-contact delay (used to pick the clip); the actual contact frame is planned inside `CONTACT_WINDOW`. |
| Contact planning | `CONTACT_WINDOW / CONTACT_SNAP` (top of `src/match.ts`), `LUNGE_MAX` (`src/config.ts`) | The ball flies its natural path; the player lunges to meet it. Window of allowed contact times, max lunge glide distance, max final ball nudge onto the limb. The same plan grades the contact — see **Touch quality** above. |
| Reach assist | `REACH_ASSIST.radius / strength` | Soft magnetism: pushing the stick roughly toward the incoming ball bends the run onto its interception point. `strength: 0` disables it. |
| Serve aim | `serveClipForAim` (in `src/character.ts`) / `launchServe` (in `src/match.ts`) | Hold a direction before/while serving: aim left → right-foot serve, right → left-foot serve, centre → head serve. The 0.25 band threshold lives in `serveClipForAim`. |
| AI difficulty | `DIFFICULTIES` / `READ` in `src/ai.ts` | easy/normal/hard presets: `speed` (fraction of the character's own speed), `reactionTime` (spent twice — once before the run starts, once before the touch), `misjudge` (metres of drop-point misread **on a slow ball**; `READ` grows it with the incoming pace — fast balls are harder to read, and the ball's own lateral travel signs the error — so misreads are earned by the shot, never rolled), `aimError` (execution looseness, also pace-pressured), `popChance`, `maxPopTouches` (the build-up is due on a rhythm and denied by pace), `tactics` (how often the return is *chosen* against where the player is standing — the choice cycles on the possession count, so the tells are learnable). The AI's serve follows `aiServePattern`: side alternates, depth cycles. Friendly games pick one; competitions use normal, then hard for finals / the last league round. |

## Rules of thumb

- **Never** lift the floor or table visuals to meet the arena — set `GROUND_Y`
  (gameplay + visuals move together) or lower the arena with `ARENA.offsetY`.
- The arena moves as one piece; align its court to the table with the offsets,
  not the other way around.
