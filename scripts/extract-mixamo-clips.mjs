// Turn Mixamo's animation-only FBX exports into one small JSON of rotation
// tracks, keyed by the bone names the crowd rig uses.
//
// Mixamo names bones `mixamorig:LeftArm`; the crowd pack names the same joint
// `<figure>_skeleton_LeftArm`. That is the whole of the retarget: both rigs are
// the same standard biped, so dropping the prefix lines them up. Bones present
// in one and not the other are simply skipped, which is why the spine mismatch
// (Mixamo stops at Spine2, the pack goes to Spine4) costs nothing.
//
// Root translation is deliberately dropped. Spectators stay on their mark; a
// hips track would walk each one off its seat.
//
//   node scripts/extract-mixamo-clips.mjs <gltf-dir> <out.json>
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2] ?? "/tmp/anim";
const outPath = process.argv[3] ?? "assets/models/Crowd/clips.json";

/** Read an accessor as an array of fixed-size tuples. */
function readAccessor(gltf, bin, index) {
  const accessor = gltf.accessors[index];
  const view = gltf.bufferViews[accessor.bufferView];
  const size = { SCALAR: 1, VEC3: 3, VEC4: 4 }[accessor.type];
  const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const floats = new Float32Array(bin.buffer, bin.byteOffset + start, accessor.count * size);
  const out = [];
  for (let i = 0; i < accessor.count; i++) out.push(Array.from(floats.subarray(i * size, i * size + size)));
  return out;
}

const clips = {};
for (const entry of readdirSync(dir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const folder = join(dir, entry.name);
  const gltfName = readdirSync(folder).find((f) => f.endsWith(".gltf"));
  if (!gltfName) continue;
  const gltf = JSON.parse(readFileSync(join(folder, gltfName), "utf8"));
  const bin = readFileSync(join(folder, gltf.buffers[0].uri));
  const animation = gltf.animations[0];

  const tracks = {};
  let duration = 0;
  for (const channel of animation.channels) {
    if (channel.target.path !== "rotation") continue;
    const name = gltf.nodes[channel.target.node].name ?? "";
    if (!name.startsWith("mixamorig:")) continue;
    const sampler = animation.samplers[channel.sampler];
    const times = readAccessor(gltf, bin, sampler.input).map((t) => t[0]);
    const values = readAccessor(gltf, bin, sampler.output);
    duration = Math.max(duration, times[times.length - 1]);
    // The node's own rotation is the clip's rest pose. Retargeting needs it:
    // the crowd rig rests mid-cheer, not in Mixamo's T-pose, so what transfers
    // between them is each bone's rotation *relative to its own rest*, never
    // the absolute value.
    const node = gltf.nodes[channel.target.node];
    const rest = node.rotation ?? [0, 0, 0, 1];
    tracks[name.slice("mixamorig:".length)] = { times, values, rest };
  }
  const clip = entry.name.replace(/_out$/, "");
  clips[clip] = { duration, tracks };
  console.log(`${clip}: ${Object.keys(tracks).length} bones, ${duration.toFixed(2)}s`);
}

writeFileSync(outPath, JSON.stringify(clips));
console.log(`wrote ${outPath}: ${(readFileSync(outPath).length / 1024).toFixed(0)} KB`);
