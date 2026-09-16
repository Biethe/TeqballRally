# Handover: the guest's screen in an online match

## What this is

A brief for whoever picks up the online rendering problem. The netcode's shape
is sound and the rules are right; what is wrong is what the **second phone**
shows. The ball does not fly smoothly, and the reception, preparation and
kicking animations do not play smoothly or all the way through.

Read `README.md` for the design and `CLAUDE.md` for the repo's traps. This file
is only about the guest's display: what is known, what has been ruled out, what
is still broken, and how to measure any of it.

Everything below was established by reading the code and by measurement, not by
guessing. Where something is a hypothesis it says so.

---

## The shape of an online match

One peer runs the entire match. The other runs no rules at all.

- **Host.** Steps the match at a fixed `SIM_DT` (1/60 s) and sends a full
  `SnapshotMessage` at `SNAPSHOT_HZ` (30). Also sends `FxMessage` for each
  contact, stamped with the tick it happened on.
- **Guest.** `MatchController.netFollower = true`. `update()` diverts to
  `updateAsFollower`, which draws everything from one timeline
  (`src/net/playback.ts`) and predicts only its own character.
- **`reframe`** (`src/net/protocol.ts`) is the single place the guest's
  mirrored world lives: a 180° rotation about Y, and a swap of the two seats.
  Every message passes through it on the way out and on the way in.

### The one thing most people get backwards

**The guest renders *ahead* of the newest frame it has, not behind it.**

```
renderTick = newestTick + lead + (steps since that frame arrived)
```

`lead` is the transport delay (`OnlineSession.leadTicks()`), so the drawn
instant is an estimate of *where the host is now*. A consequence worth knowing
before touching `bufferedView`: the sample `b` in the interpolation branch is
always `null`, because no buffered sample is ever later than the render point.
Characters are carried forward by the velocity on the wire; the ball is carried
forward by the shared pure physics.

I lost an hour building a fix for a phase-timing bug that does not exist,
because I assumed the screen lagged the feed. It does not.

---

## The root cause of most of this: two clocks, and they diverge twice

Animation clips are advanced by Babylon off the **render loop**, in wall time.
Everything else — the ball, the positions, the clip *windows* that say when a
clip should be where — is measured in **simulation ticks**. They agree only
while the two clocks agree, and there are two separate reasons they do not.

### 1. The simulation is throttled and the animations are not

`src/main.ts`:

```ts
const dt = Math.min(gs.engine.getDeltaTime() / 1000, MAX_FRAME_DT) * timeScale;
```

`MAX_FRAME_DT` is 1/20 s, and the remainder is **dropped**, not carried. On a
device that stutters — an emulator above all — the simulation falls behind wall
time while Babylon's animations do not. A clip therefore reaches its own end
with its window still open, or overruns a window that has already closed.

This is confirmed, and it is the mechanism behind the fixes already made below.

### 2. The two peers may be running at different speeds — UNFIXED, START HERE

`timeScale` comes from `prefs.gameSpeed`, which is **a per-device setting** with
two values, 1.25 and 1.45. It scales the simulation (above) and the animations
(`gs.scene.animationTimeScale = timeScale`). Consistently — on one device.

`timeScale` appears **nowhere** in `src/net/` and nowhere in `src/match.ts`.
Nothing exchanges it, and nothing reconciles it.

So if the host is on 1.25 and the guest on 1.45:

- the guest's animations run ~16% fast against windows expressed in host ticks;
- the guest's own simulation steps ~16% fast, so `stepsSince` grows too quickly
  and `renderTick` races ahead of where the host really is;
- the ball is therefore permanently over-extrapolated, permanently corrected,
  and never smooth.

**This is a hypothesis, but a well-supported one, and it is cheap to test:** set
both emulators to the same gameplay speed and see whether the problem changes
character. If it does, the fix is to put the host's `timeScale` in
`SetupMessage` or `SnapshotMessage` and have the guest adopt it for the duration
of the match. Note that it must reach both the simulation step and
`scene.animationTimeScale`, and that it must be restored when the match ends.

---

## Already fixed — do not redo these

Recent commits, newest first. Each has a test that fails against the code
before it.

| Commit | What |
| --- | --- |
| `066e02a` | Contactless clips (celebrations, stunts, defeat) are no longer pinned to the tick clock at all — they start once and run. Clips that *do* have a contact are steered by playback rate (`Character.steerAction`) instead of being yanked with `goToFrame`. The lag-compensation rewind is bounded by the measured link instead of a flat half second. Stamina from the wire is floored at `MIN_EFFORT`. |
| `1e79a7d` | A clip that ends before its window closes is re-seated **once**, not on every frame. It used to loop for ever: the last sliver played, ended, restarted. That was the looping victory celebration, and the same loop on a kick is why the ball appeared to leave after the strike. |
| `949f1fe` | The ball no longer hangs at a contact it cannot resolve for longer than `MAX_PIN_TICKS` (8). The character whose feet the host takes mid-touch no longer teleports: the drift is kept as an offset and bled off over `FOLLOWER_HANDOFF_SECONDS`. |
| `4bcbafb` | The guest's ball actually spins (it was moved with `update(0)`, and the spin term is multiplied by dt). Stamina crosses the wire, so the guest's prediction no longer runs on fresh legs while the host's character is exhausted. |

Earlier work in the same area, all still in place: clip windows carrying
`from`/`to`/`seq` so a clip plays at the right fraction of the right instant;
wire velocity rather than a differenced position; the ball pinned at a predicted
contact; lag compensation via `viewTick`; the guest predicting its own character
with the same reach assist and leash the host runs.

---

## Still reported broken

From the person testing on two emulators, after `066e02a`:

1. **The ball does not fly smoothly.** Not a freeze any more — a lack of
   smoothness.
2. **Reception, preparation and kicking animations do not play smoothly or all
   the way through.** These are the contact clips, so they are still pinned and
   still steered.
3. **Characters "disappear" for a few milliseconds to a second** during a
   rally. Unreproduced. See below.
4. **A frozen feeling that makes the ball physics look off.**

### On the disappearing

I could not reproduce it. Four thousand ticks with jittered delivery, through
several points, checking every character and ball position on the guest for
non-finite or out-of-court values: none. Nothing in `src/` hides a character —
there is no `setEnabled`, `isVisible` or `visibility` call on a character mesh
anywhere.

That leaves the rendering layer, which the headless tests do not exercise
because `FakeCharacter` in `tests/rig.ts` has no meshes, no skeleton and no
animation groups. Two things worth checking on a device:

- whether the whole body vanishes or collapses in on itself, which separate a
  culling or position problem from a skeleton one;
- whether `Character.playAction` ever returns false while the locomotion weights
  are already at zero, which would leave a rig with nothing playing at all.

---

## Where to look

| File | What lives there |
| --- | --- |
| `src/net/playback.ts` | The guest's timeline. `bufferedView` is the heart of it: render point, character carry, ball stepping, contact pinning, `easeBall`. |
| `src/match.ts` → `updateAsFollower` | One guest frame: ball, clips, prediction, reconcile, handover. |
| `src/match.ts` → `updateFollowerClips` | Which clip plays, at what fraction, at what rate. Most of the animation problems are here or in what feeds it. |
| `src/match.ts` → `predictSelf` | The guest's own character. Must integrate the *same* equation as the host's `updateVersusRally`, or the error is regenerated every step. |
| `src/net/session.ts` | `sendSnapshot` (what crosses), the `case "input"`/`case "snap"` handlers, `leadTicks()`. |
| `src/character.ts` | `playAction`, `seekAction`, `steerAction`, `finishAction`, `move`. |
| `src/config.ts` | `CLIPS`: frames and contact frame per clip. Comment says clips run at 60 fps. |

### Constants you will end up tuning

| Name | Value | Where |
| --- | --- | --- |
| `SIM_HZ` / `SIM_DT` | 60 / 1÷60 | `src/config.ts` |
| `MAX_FRAME_DT` | 1/20 | `src/main.ts` |
| `SNAPSHOT_HZ` | 30 | `src/net/session.ts` |
| `LEAD_JITTER_CAP_TICKS` | 3 | `src/net/session.ts` |
| `MAX_CATCHUP_TICKS` | 30 (0.5 s) | `src/net/protocol.ts` |
| `PLAYBACK_MAX_ENTRIES` | 8 | `src/net/playback.ts` |
| `PLAYBACK_STALE_STEPS` | 18 | `src/net/playback.ts` |
| `PLAYBACK_MAX_EXTRAPOLATE_TICKS` | 30 | `src/net/playback.ts` |
| `MAX_PIN_TICKS` | 8 | `src/net/playback.ts` |
| `BALL_CORRECT_SECONDS` | 0.1 | `src/net/playback.ts` |
| `BALL_SNAP` | 3.0 m | `src/net/playback.ts` |
| `MAX_CHAR_CARRY_METRES` | 1.0 | `src/net/playback.ts` |
| `FOLLOWER_SNAP` | 3.0 m | `src/match.ts` |
| `FOLLOWER_BLEND_SECONDS` | 0.25 | `src/match.ts` |
| `FOLLOWER_HANDOFF_SECONDS` | 0.1 | `src/match.ts` |
| `CLIP_RESYNC_FRACTION` | 0.08 | `src/match.ts` |
| `ACTION_SEEK_FRACTION` | 0.35 | `src/character.ts` |
| `ACTION_STEER_GAIN` | 6 | `src/character.ts` |

---

## How to measure this, which is most of the work

`npm run check` is the gate: typecheck, lint, and about 1063 tests.

### The harness

`tests/follower.test.ts` has `feed(host, guest, delay, jitter, lead)`, which
runs two real `MatchController`s and moves frames between them the way the
session does.

**Always pass jitter.** A fixed delay is the easy case and hides nearly
everything: it hid both faults fixed in `949f1fe`. `feed(host, guest, 6, 10, 6)`
is a reasonable phone.

**Pass a lead.** It defaults to 0 for the sake of older tests in that file, and
a real session always leads. Several of those older tests are therefore
exercising a configuration that never occurs; fixing that is worthwhile but was
out of scope.

The harness now carries `selfAnchor`, `selfAnchorEta`, `selfLocked`,
`strikeable` and `touches`. It did not until recently, which meant every test in
that file drove a guest that never ran the reach assist and never handed its
feet over — the whole prediction path, untested. Assume similar gaps elsewhere.

### The recipe that actually found things

Write a throwaway `tests/zz-probe.test.ts`, run a long rally with jitter, and
**measure** rather than assert: longest run of frames where the ball does not
move; largest single-frame movement of the guest's own character with no stick
input; count of non-finite values. Print them. Then revert the fix and run it
again with the same seed.

Two things to get right or the numbers are worthless:

- **Seed `Math.random`.** The AI uses it, and two runs are otherwise
  incomparable. This is how a fix first appeared to make a stall worse.
- **A test that passes in both arms proves nothing.** I wrote one, noticed, and
  replaced it with a unit test on `PlaybackBuffer` that reproduces the stall
  deterministically (39 frames of motionless ball before, under 12 after).

### Traps

- **Never spread a Babylon `Vector3`.** `{...vec}` copies `_x/_y/_z`, not the
  accessors, so the result has no `x` at all. It silently fed a probe garbage
  for half an hour. The typechecker catches it wherever the target is typed.
- `FakeCharacter.finishActionEarly()` models a clip ending while the tick clock
  lags. There is no way to reach that state by stepping the fake otherwise,
  because its clip runs on the same clock as everything else in it.
- The relay's queue outlives a test. A socket left waiting pairs with the next
  test's first caller.

### On device

```bash
npm run android:apk    # then copy from android/app/build/outputs/apk/debug/
```

Two emulators, both signed in to different profiles. The second to join is the
guest and the one with the problems.

---

## Suggested order of attack

1. **Agree `timeScale` between the peers.** Highest value, cheapest to test,
   and the only known unfixed divergence. Confirm first by setting both devices
   to the same gameplay speed.
2. **Decide whether contact clips should be pinned to the tick clock at all.**
   They are pinned so the foot and the ball describe one instant. Now that the
   rate steering is in, measure what the residual drift actually is before
   assuming the pinning is still earning its cost. If the contact is what
   matters, consider pinning only the approach to the contact frame and letting
   the follow-through run free, the way contactless clips now do.
3. **Look at the ball's smoothness specifically**, separately from the clips.
   `easeBall` corrects position while velocity is taken from the truth
   immediately, which is deliberate but means a correction and a velocity change
   can disagree for `BALL_CORRECT_SECONDS`. Measure the second derivative of the
   drawn ball position over a rally; smooth flight is the property, not small
   error.
4. **Reproduce the disappearing on a device** before theorising. It is the only
   symptom with no mechanism attached to it, and the headless tests cannot see
   the rendering layer where it must live.

## One more thing

The person testing this is shipping to a Play closed test and has production
access. Protocol changes lock every older build out of online play, because the
relay refuses a version it does not match, and the relay and the clients always
ship together. `PROTOCOL_VERSION` is currently 4. Adding an *optional* field to
a snapshot needs no bump, because the relay never parses snapshots — that is the
cheap way to send the host's `timeScale`.
