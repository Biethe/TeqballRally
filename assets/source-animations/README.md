# Source animations

Mixamo FBX exports waiting to be turned into something the game can play.
Nothing here is loaded at runtime — these are the inputs to an offline
pipeline, and they live in the repository because the uploads that carried
them were not going to survive the session.

## `crowd/` — spectators

| File | What it is |
| --- | --- |
| `Idle.fbx` | Standing, doing nothing much |
| `Bored.fbx` | Weight shift, looking around |
| `Pouting.fbx` | Unimpressed |
| `Male_Standing_Pose_3.fbx` | A static standing pose |
| `Male_Standing_Pose_4.fbx` | A static standing pose |

These answer a real problem with the current crowd, which is that everybody in
it is celebrating all of the time. `CROWD_FIGURES` in `src/crowdclips.ts` gives
each of the five figures a different motion — cheering, fist pump, two sitting
claps — and that stops them being a chorus line, but it does not stop them all
being *delighted*, permanently, including between points and while nothing is
happening. A stand where some people are bored and one is sulking reads as a
crowd; a stand where two hundred people cheer without pause reads as wallpaper.

### The pipeline

The crowd is not skinned at runtime. Every figure is one drawable mesh whose
animation is baked into a vertex animation texture (`.vat`), which is what lets
a few hundred spectators cost almost nothing on a phone. Three stages:

1. **FBX → glTF.** The extractor reads glTF, not FBX, so convert first
   (Blender, or FBX2glTF). One directory, one subdirectory per clip.

2. **Retarget to rotation deltas.**

   ```bash
   node scripts/extract-mixamo-clips.mjs <gltf-dir> assets/models/Crowd/clips.json 48
   ```

   Read the header of that script before changing anything in it. It transfers
   *world-space rotation deltas* rather than local rotations, because Mixamo
   rests in a T-pose and these crowd figures rest mid-cheer with different bone
   axes — mapping locals tore every figure apart. `clips.json` is an
   intermediate and is deliberately not committed.

3. **Bake to textures.**

   ```bash
   npm run dev -- --port 5178 --strictPort
   CHROMIUM_PATH=... node scripts/bake-crowd.mjs
   ```

   Writes `assets/models/Crowd/*.vat`. It renders one frame per baked frame
   under software rendering, so it is slow; it is a one-off.

Then add or repoint an entry in `CROWD_FIGURES`. The clip name there has to
match the folder name the conversion produced.

### Two things to decide before baking

**48 frames, always.** `CROWD_FRAMES` is the height of every texture and every
clip is resampled to it, whatever its recorded length. A two-second idle and a
six-second bored loop both become 48 frames, so the idle plays slow and the
bored one fast. At crowd distance that has been fine, and it is what keeps
every texture the same shape — but these clips are longer and calmer than the
cheers already in there, so check what the resampling does to them before
committing a bake.

**The two standing poses may be single-frame.** If they are, baking them into
48 identical rows is a waste of texture; a still figure needs no `.vat` at all
and could be drawn as a plain mesh. Worth checking rather than assuming.
