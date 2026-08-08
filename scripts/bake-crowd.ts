// Offline bake: turns each rigged crowd figure into a texture of bone
// matrices, which the game loads as a file instead of computing at startup.
//
// Driven by scripts/bake-crowd.mjs; not a build entry, so it never ships.
//
// The bake itself is fixed and produces real motion — see the two notes below
// — but the figures still shred when rendered. The remaining fault is in the
// rig, not here: these skins bind with a x100 bind-shape matrix that lives in
// the bone chain. At the bind pose it cancels out, which is why a static bake
// rendered correctly; the moment a bone rotates, every offset below it is
// multiplied by a hundred and the limbs fly hundreds of metres.
//
// The fix belongs in scripts/extract-crowd-figure.py: fold that x100 into the
// geometry and the joint translations so the bind-shape matrix comes out as
// identity, then re-extract, re-pack and re-bake. Retargeting is already
// correct in principle here — both quaternion composition orders were tried
// and both explode identically, which is what a scale fault looks like and a
// rotation fault does not.
//
// Two things here were hard won and are the reason the bake works at all.
//
// The pose goes on each bone's *linked transform node*, not on the bone.
// Babylon's glTF loader links every bone to a TransformNode, and
// Skeleton.prepare() copies position/rotation/scaling from that node onto the
// bone before computing anything. Writing to the bone therefore appeared to
// work and was silently reverted on the next prepare — which is why
// setRotationQuaternion, updateMatrix and hand-written matrices all produced a
// skeleton that never moved.
//
// The matrices are read after an explicit prepare(true) rather than after a
// rendered frame. prepare() skips its work when the scene's render id has not
// moved, which inside a bake loop it never does; forcing it makes the whole
// bake synchronous. Babylon's own VertexAnimationBaker is deliberately not
// used: it drives scene.beginAnimation(skeleton), which plays bone.animations,
// and a glTF import has none — it faithfully bakes a skeleton that nothing is
// animating, which is what produced 48 identical frames.
import { Engine } from "@babylonjs/core/Engines/engine";
import { Scene } from "@babylonjs/core/scene";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import "@babylonjs/loaders/glTF/2.0";
import { CROWD_FIGURES, CROWD_FRAMES } from "../src/crowdclips";

const canvas = document.getElementById("c") as HTMLCanvasElement;
const engine = new Engine(canvas, true);
const scene = new Scene(engine);
new FreeCamera("c", new Vector3(0, 1, -4), scene);

interface Track {
  times: number[];
  values: number[][];
  /** The bone's rotation in Mixamo's own rest pose. */
  rest: number[];
}
interface Clip {
  duration: number;
  tracks: Record<string, Track>;
}

const clips: Record<string, Clip> = await (await fetch("/clips.json")).json();

/** The rotation a track holds at time `t`, interpolated between its keys. */
function sample(track: Track, t: number, out: Quaternion): void {
  const { times, values } = track;
  let i = 1;
  while (i < times.length && times[i] < t) i++;
  const previous = values[i - 1];
  const next = values[Math.min(i, values.length - 1)];
  const span = times[Math.min(i, times.length - 1)] - times[i - 1];
  const k = span > 1e-6 ? (t - times[i - 1]) / span : 0;
  Quaternion.SlerpToRef(
    new Quaternion(previous[0], previous[1], previous[2], previous[3]),
    new Quaternion(next[0], next[1], next[2], next[3]),
    Math.min(1, Math.max(0, k)),
    out
  );
}

/** Base64 in chunks: spreading a 166 KB buffer as arguments blows the stack. */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// Control for this bake itself: with no pose applied, every frame must be the
// bind pose and must render exactly as the unanimated figure does.
const BIND_ONLY = new URLSearchParams(location.search).get("bind") === "1";

const results: Record<string, { width: number; height: number; data: string }> = {};

for (const figure of CROWD_FIGURES) {
  const res = await SceneLoader.ImportMeshAsync("", "/models/Crowd/", figure.file, scene);
  const mesh = res.meshes.find((m) => m.getTotalVertices() > 0)!;
  const skeleton = res.skeletons[0];
  const clip = clips[figure.clip];
  if (!clip) throw new Error(`no clip named ${figure.clip}`);

  // Strip the mesh's node transform exactly as crowdrig.ts does at runtime.
  // The pack binds its skins with a x100 bind-shape matrix that the importer
  // parks on this node, and the baked matrices are only valid for the mesh
  // they were computed against — bake with the node and play back without it
  // and the figures shred into shards.
  mesh.parent = null;
  mesh.position.setAll(0);
  mesh.rotationQuaternion = null;
  mesh.rotation.setAll(0);
  mesh.scaling.setAll(1);
  mesh.computeWorldMatrix(true);

  // getTransformMatrices folds in the mesh's pose matrix when this is set,
  // which puts the matrices in a space the baked-animation shader knows
  // nothing about. The shader reads them raw, so bake them raw.
  console.log(`   needInitialSkinMatrix was ${skeleton.needInitialSkinMatrix}`);
  skeleton.needInitialSkinMatrix = false;

  // Mixamo names a joint `mixamorig:LeftArm`; this rig names it
  // `<figure>_skeleton_LeftArm`. Both are the same standard biped, so the
  // suffix lines them up, and a joint in one rig but not the other is simply
  // left in its rest pose.
  // Never retarget the root or the hips. Each figure was exported at the seat
  // it occupied in the pack's grandstand, so its root sits about six metres
  // from the origin; turning it swings the whole body through an arc that
  // wide, which is what tore the figures into shards. A spectator stands on
  // its mark anyway — only the body above the hips needs to move.
  const ROOTS = new Set(["Root", "Hips"]);
  const posed: { node: TransformNode; track: Track; rest: Quaternion; source: Quaternion }[] = [];
  for (const bone of skeleton.bones) {
    const short = bone.name.split("_skeleton_")[1];
    if (short && ROOTS.has(short)) continue;
    const track = short ? clip.tracks[short] : undefined;
    const node = bone.getTransformNode();
    if (!track || !node) continue;
    node.rotationQuaternion ??= node.rotation.toQuaternion();
    const r = track.rest;
    posed.push({
      node,
      track,
      rest: node.rotationQuaternion.clone(),
      source: new Quaternion(r[0], r[1], r[2], r[3]).invert(),
    });
  }

  // Small rotations about each bone's own local axes, chosen to read as
  // applause from the touchline: forearms lead, upper arms follow at half the
  // travel, the torso rocks once per loop under them.
  const AUTHORED: { bone: string; axis: Vector3; amplitude: number; cycles: number; phase: number }[] = [
    { bone: "LeftForeArm", axis: new Vector3(0, 1, 0), amplitude: 0.30, cycles: 2, phase: 0 },
    { bone: "RightForeArm", axis: new Vector3(0, 1, 0), amplitude: 0.30, cycles: 2, phase: Math.PI },
    { bone: "LeftArm", axis: new Vector3(0, 1, 0), amplitude: 0.16, cycles: 2, phase: 0.4 },
    { bone: "RightArm", axis: new Vector3(0, 1, 0), amplitude: 0.16, cycles: 2, phase: Math.PI + 0.4 },
    { bone: "Spine2", axis: new Vector3(0, 0, 1), amplitude: 0.05, cycles: 1, phase: 0 },
    { bone: "Neck", axis: new Vector3(0, 0, 1), amplitude: 0.06, cycles: 2, phase: 0.8 },
  ];
  const authored = AUTHORED.flatMap((swing) => {
    const bone = skeleton.bones.find((b) => b.name.endsWith(`_skeleton_${swing.bone}`));
    const node = bone?.getTransformNode();
    if (!node) return [];
    node.rotationQuaternion ??= node.rotation.toQuaternion();
    return [{ node, rest: node.rotationQuaternion.clone(), swing }];
  });

  const perFrame = (skeleton.bones.length + 1) * 16;
  const data = new Float32Array(perFrame * CROWD_FRAMES);
  const sampled = new Quaternion();
  for (let frame = 0; frame < CROWD_FRAMES; frame++) {
    // Walk the clip's own length across our fixed frame count, so a 6.5 s
    // sitting clap and a 1.2 s clap both loop cleanly in the same many rows.
    const t = (frame / CROWD_FRAMES) * clip.duration;
    // Retargeting Mixamo's rotations onto this rig still tears the figures
    // apart — see the note at the top of this file — so the motion is authored
    // here for now. The bake path itself is proven: baking with no pose at all
    // renders the figures intact, so what follows is only as good as these
    // angles, and they are deliberately small.
    if (!BIND_ONLY) {
      for (const { node, rest, swing } of authored) {
        const angle = swing.amplitude * Math.sin((t / clip.duration) * swing.cycles * Math.PI * 2 + swing.phase);
        rest.multiplyToRef(Quaternion.RotationAxis(swing.axis, angle), node.rotationQuaternion!);
      }
    }
    skeleton.prepare(true);
    data.set(skeleton.getTransformMatrices(mesh), frame * perFrame);
  }

  // Widest gap between frame 0 and any other frame. Comparing against the
  // halfway frame alone reported 0 for a two-cycle loop, where frame 24 is
  // frame 0 by construction — a check that quietly passes a still crowd.
  let spread = 0;
  for (let frame = 1; frame < CROWD_FRAMES; frame++) {
    for (let i = 0; i < perFrame; i++) {
      spread = Math.max(spread, Math.abs(data[i] - data[frame * perFrame + i]));
    }
  }
  // How far a baked matrix translates, at rest and in motion. A rig whose
  // scale is amplifying rotations shows up here as metres at frame 0 and
  // hundreds of metres mid-clip.
  const maxTranslation = (frame: number): number => {
    let m = 0;
    for (let b = 0; b < skeleton.bones.length; b++) {
      const o = frame * perFrame + b * 16;
      m = Math.max(m, Math.abs(data[o + 12]), Math.abs(data[o + 13]), Math.abs(data[o + 14]));
    }
    return m;
  };
  console.log(
    `   translation: rest ${maxTranslation(0).toFixed(2)}, ` +
      `mid ${maxTranslation(CROWD_FRAMES >> 1).toFixed(2)}`
  );
  console.log(
    `baked ${figure.file} as ${figure.clip}: ` +
      `${posed.length}/${skeleton.bones.length} bones retargeted, spread ${spread.toFixed(4)}`
  );

  results[figure.file] = {
    width: (skeleton.bones.length + 1) * 4,
    height: CROWD_FRAMES,
    data: toBase64(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)),
  };

  for (const m of res.meshes) m.dispose();
  skeleton.dispose();
}

(window as unknown as { __bake: unknown }).__bake = results;
