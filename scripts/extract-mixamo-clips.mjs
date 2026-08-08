// Turn Mixamo's animation-only FBX exports into world-space rotation deltas,
// resampled to the crowd's frame count.
//
// Why deltas, and why world space. Copying a bone's local rotation from one rig
// to another only works if both rigs orient that bone the same way. Mixamo
// rests in a T-pose; these crowd figures rest mid-cheer, and their bone axes
// differ besides. Mapping locals tore every figure apart, and picking rotation
// axes by hand produced motion that reads as neither clapping nor anything
// else.
//
// What does transfer cleanly is how far a bone has turned *in the world*
// between its own rest and the frame in question. That quantity is independent
// of how either rig names or orients its axes, so the target rig can take it
// and convert back into whatever local space it happens to use.
//
//   node scripts/extract-mixamo-clips.mjs <gltf-dir> <out.json> [frames]
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2] ?? "/tmp/anim";
const outPath = process.argv[3] ?? "assets/models/Crowd/clips.json";
const FRAMES = Number(process.argv[4] ?? 48);

const mul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const conj = (q) => [-q[0], -q[1], -q[2], q[3]];

function slerp(a, b, t) {
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  let end = b;
  if (dot < 0) {
    dot = -dot;
    end = [-b[0], -b[1], -b[2], -b[3]];
  }
  if (dot > 0.9995) {
    const out = a.map((v, i) => v + t * (end[i] - v));
    const n = Math.hypot(...out) || 1;
    return out.map((v) => v / n);
  }
  const theta = Math.acos(dot);
  const s = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / s;
  const wb = Math.sin(t * theta) / s;
  return a.map((v, i) => wa * v + wb * end[i]);
}

/** Read an accessor as an array of fixed-size tuples. */
function readAccessor(gltf, bin, index) {
  const accessor = gltf.accessors[index];
  const view = gltf.bufferViews[accessor.bufferView];
  const size = { SCALAR: 1, VEC3: 3, VEC4: 4 }[accessor.type];
  const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const floats = new Float32Array(bin.buffer, bin.byteOffset + start, accessor.count * size);
  const out = [];
  for (let i = 0; i < accessor.count; i++) {
    out.push(Array.from(floats.subarray(i * size, i * size + size)));
  }
  return out;
}

function sampleTrack(track, t) {
  const { times, values } = track;
  let i = 1;
  while (i < times.length && times[i] < t) i++;
  const previous = values[i - 1];
  const next = values[Math.min(i, values.length - 1)];
  const span = times[Math.min(i, times.length - 1)] - times[i - 1];
  const k = span > 1e-6 ? Math.min(1, Math.max(0, (t - times[i - 1]) / span)) : 0;
  return slerp(previous, next, k);
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

  const parent = new Map();
  gltf.nodes.forEach((node, i) => {
    for (const child of node.children ?? []) parent.set(child, i);
  });

  const tracks = new Map();
  let duration = 0;
  for (const channel of animation.channels) {
    if (channel.target.path !== "rotation") continue;
    const sampler = animation.samplers[channel.sampler];
    const times = readAccessor(gltf, bin, sampler.input).map((t) => t[0]);
    const values = readAccessor(gltf, bin, sampler.output);
    duration = Math.max(duration, times[times.length - 1]);
    tracks.set(channel.target.node, { times, values });
  }

  /** A node's rotation in world space, composed up the parent chain. */
  const world = (index, localOf) => {
    let q = localOf(index);
    for (let p = parent.get(index); p !== undefined; p = parent.get(p)) {
      q = mul(localOf(p), q);
    }
    return q;
  };
  const restLocal = (i) => gltf.nodes[i].rotation ?? [0, 0, 0, 1];

  const deltas = {};
  for (const [index] of tracks) {
    const name = gltf.nodes[index].name ?? "";
    if (!name.startsWith("mixamorig:")) continue;
    const restWorld = world(index, restLocal);
    const inverseRest = conj(restWorld);
    const frames = [];
    for (let f = 0; f < FRAMES; f++) {
      const t = (f / FRAMES) * duration;
      const localAt = (i) => {
        const track = tracks.get(i);
        return track ? sampleTrack(track, t) : restLocal(i);
      };
      // How far this bone has turned in the world since its own rest.
      frames.push(mul(world(index, localAt), inverseRest).map((v) => +v.toFixed(5)));
    }
    deltas[name.slice("mixamorig:".length)] = frames;
  }

  const clip = entry.name.replace(/_out$/, "");
  clips[clip] = { duration: +duration.toFixed(3), frames: FRAMES, deltas };
  console.log(`${clip}: ${Object.keys(deltas).length} bones, ${duration.toFixed(2)}s`);
}

writeFileSync(outPath, JSON.stringify(clips));
console.log(`wrote ${outPath}: ${(readFileSync(outPath).length / 1024).toFixed(0)} KB`);
