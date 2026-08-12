# Source animations

Mixamo FBX clips waiting to be retargeted onto the player rig. Nothing in this
folder is loaded at runtime — the game only ever reads the GLBs in
`assets/models/characters/`, which carry their animation groups baked in.

These are here because the upload that carried them was ephemeral and the
retargeting needs a tool this repository does not have.

| File | What it is | Intended use |
| --- | --- | --- |
| `Idle.fbx` | A calmer standing idle | Replace or alternate with the current `Idle` |
| `Bored.fbx` | Weight shift, looking around | Between points, after a long wait |
| `Pouting.fbx` | Frustration | After losing a point |
| `Male_Standing_Pose_3.fbx` | Static pose | Menu / character select stance |
| `Male_Standing_Pose_4.fbx` | Static pose | Menu / character select stance |

## Getting one into the game

1. Import the character GLB into Blender, then import the FBX with **Automatic
   Bone Orientation** on.
2. Retarget onto the character's armature. All four players share the Mixamo
   rig, so one retarget maps to all of them.
3. Name the action exactly what the code will ask for — the animation group's
   name is the lookup key (see `CLIPS` in `src/config.ts`).
4. Export GLB with animations, overwriting the file in
   `assets/models/characters/`.
5. Add the clip's frame count to `Animation.txt` **and** to `CLIPS` in
   `src/config.ts`. `tests/config.test.ts` parses `Animation.txt` and fails if
   the two disagree, which is the guard that keeps them in step.

A clip with no ball contact has `contactFrame: -1`; these idles all do.
