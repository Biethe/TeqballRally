// Offline bake: turns each rigged crowd figure into a texture of bone
// matrices, which the game loads as a file instead of computing at startup.
//
// Driven by scripts/bake-crowd.mjs; not a build entry, so it never ships.
//
// Three things here were hard won.
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
// animating.
//
// UNRESOLVED: retargeting Mixamo motion onto this rig still tears the figures
// apart, so the bake currently ships with BIND=1 — the figures' own cheer
// pose, held. That renders correctly, which is the point: the bake, the
// texture, the layout and the playback are all proven by it.
//
// What has been ruled out. Copying local rotations fails, as expected, since
// Mixamo rests in a T-pose and these figures rest mid-cheer. Transferring
// world-space rotation deltas — how far a bone has turned since its own rest,
// which should belong to neither rig's conventions — fails identically, and
// that is the surprise. Both quaternion composition orders were tried on the
// local version. Hand-picked rotation axes were tried and produced motion that
// read as nothing recognisable, because the axis measurement they came from
// was taken while the skeleton was not responding to posing at all.
//
// Also ruled out: limiting the retarget to the four arm bones, in case the
// error was compounding down the thirty-bone finger chains. The arms shred
// identically, so the transfer itself is wrong rather than accumulating.
//
// What has not been checked, and is where to start: whether Babylon's
// Quaternion.multiply composes in the same order as its matrices do. Babylon
// uses row-vector matrices, so a world matrix is local x parent; if its
// quaternion product is the other way round, every hierarchy composition here
// and in extract-mixamo-clips.mjs is inverted, which would corrupt the delta
// while leaving each script self-consistent. Test it directly on two known
// rotations before writing any more retarget code.
import { Engine } from "@babylonjs/core/Engines/engine";
import { Scene } from "@babylonjs/core/scene";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import type { Bone } from "@babylonjs/core/Bones/bone";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import "@babylonjs/loaders/glTF/2.0";
import { CROWD_FIGURES, CROWD_FRAMES } from "../src/crowdclips";

const canvas = document.getElementById("c") as HTMLCanvasElement;
const engine = new Engine(canvas, true);
const scene = new Scene(engine);
new FreeCamera("c", new Vector3(0, 1, -4), scene);

interface Clip {
  duration: number;
  frames: number;
  /** Bone name to one world-space rotation delta per frame. */
  deltas: Record<string, number[][]>;
}

/**
 * Retarget data for figures that carry no animation of their own.
 *
 * Optional now, and absent: every figure in the set ships its own clips, so
 * nothing is retargeted and the file was never regenerated. Left in place
 * rather than deleted because the retarget path below is the only record of
 * what was tried, and a figure without animation would still need it.
 */
const clips: Record<string, Clip> = await fetch("/clips.json")
  .then((r) => (r.ok ? (r.json() as Promise<Record<string, Clip>>) : {}))
  .catch(() => ({}));

/** Base64 in chunks: spreading a 166 KB buffer as arguments blows the stack. */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// Control for the bake itself: with no pose applied, every frame must be the
// bind pose and must render exactly as the unanimated figure does.
const BIND_ONLY = new URLSearchParams(location.search).get("bind") === "1";

/**
 * Which bones take the retargeted motion.
 *
 * Only the arms. A whole-skeleton retarget shreds the figures, and the hands
 * alone are thirty of the fifty-three bones — long chains where a small error
 * in the transfer compounds all the way to the fingertips. The arms are four
 * bones deep and carry nearly all of what a cheering crowd reads as.
 */
const RETARGET = new Set(["LeftArm", "RightArm", "LeftForeArm", "RightForeArm"]);

const results: Record<string, { width: number; height: number; data: string }> = {};

for (const figure of CROWD_FIGURES) {
  const res = await SceneLoader.ImportMeshAsync("", "/models/Crowd/", figure.file, scene);
  const meshes = res.meshes.filter((m) => m.getTotalVertices() > 0);
  // Mixamo ships a decorative joint-marker mesh alongside the body.
  const mesh = meshes.find((m) => !/Joints/i.test(m.name)) ?? meshes[0];
  const skeleton = res.skeletons[0];

  // A figure that carries its own animation needs no retargeting at all: its
  // mesh, rig and motion come from one source with one set of conventions.
  // That is the whole reason retargeting was ever attempted, and the whole
  // reason it kept failing.
  // Named, not first: every figure ships all eight clips, so taking index 0
  // would bake the whole crowd doing whichever one the exporter happened to
  // write first — one motion, seven times over.
  const own =
    res.animationGroups.find((g) => g.name === figure.clip) ??
    res.animationGroups.find((g) => g.name.toLowerCase() === figure.clip.toLowerCase());
  if (!own && res.animationGroups.length > 0) {
    throw new Error(
      `${figure.file} has no clip "${figure.clip}" — it has: ` +
        res.animationGroups.map((g) => g.name).join(", ")
    );
  }
  if (own) {
    for (const g of res.animationGroups) g.stop();
    own.play(false);
    const perFrameOwn = (skeleton.bones.length + 1) * 16;
    const dataOwn = new Float32Array(perFrameOwn * CROWD_FRAMES);
    for (let frame = 0; frame < CROWD_FRAMES; frame++) {
      own.goToFrame(own.from + ((own.to - own.from) * frame) / CROWD_FRAMES);
      skeleton.prepare(true);
      dataOwn.set(skeleton.getTransformMatrices(mesh), frame * perFrameOwn);
    }
    let spreadOwn = 0;
    for (let frame = 1; frame < CROWD_FRAMES; frame++) {
      for (let i = 0; i < perFrameOwn; i++) {
        spreadOwn = Math.max(spreadOwn, Math.abs(dataOwn[i] - dataOwn[frame * perFrameOwn + i]));
      }
    }
    console.log(
      `baked ${figure.file} from its own ${own.name}: ` +
        `${skeleton.bones.length} bones, ${mesh.getTotalIndices() / 3} tris, spread ${spreadOwn.toFixed(4)}`
    );
    // A figure that never moves is a statue in a crowd, and the only sign of it
    // is this number — the texture bakes, loads and renders perfectly either
    // way. Several of these files ship poses rather than animations
    // (StandingPose2 measured exactly 0), so the difference has to be fatal
    // here or it reaches the stands unnoticed.
    if (spreadOwn === 0) {
      throw new Error(
        `${figure.file}: clip "${own.name}" does not move — it is a pose, not an animation. ` +
          `Pick another in src/crowdclips.ts.`
      );
    }
    results[figure.file] = {
      width: (skeleton.bones.length + 1) * 4,
      height: CROWD_FRAMES,
      data: toBase64(new Uint8Array(dataOwn.buffer, dataOwn.byteOffset, dataOwn.byteLength)),
    };
    for (const m of res.meshes) m.dispose();
    skeleton.dispose();
    continue;
  }

  const clip = clips[figure.clip];
  if (!clip) throw new Error(`no clip named ${figure.clip}`);

  // Match crowdrig.ts, which renders the mesh with no node transform of its
  // own: the baked matrices are only valid for the mesh they were taken from.
  mesh.parent = null;
  mesh.position.setAll(0);
  mesh.rotationQuaternion = null;
  mesh.rotation.setAll(0);
  mesh.scaling.setAll(1);
  mesh.computeWorldMatrix(true);

  // Parents before children: a bone's new world rotation is built from its
  // parent's, so the parent has to have been solved already this frame.
  const depthOf = (bone: Bone): number => {
    let d = 0;
    for (let n = bone.getParent(); n; n = n.getParent()) d++;
    return d;
  };
  const chain = [...skeleton.bones].sort((a, b) => depthOf(a) - depthOf(b));

  const nodeOf = new Map<Bone, TransformNode>();
  const restLocal = new Map<Bone, Quaternion>();
  const restWorld = new Map<Bone, Quaternion>();
  let retargeted = 0;
  for (const bone of chain) {
    const node = bone.getTransformNode();
    if (!node) continue;
    node.rotationQuaternion ??= node.rotation.toQuaternion();
    nodeOf.set(bone, node);
    restLocal.set(bone, node.rotationQuaternion.clone());
    const parent = bone.getParent();
    const parentWorld = parent ? restWorld.get(parent) : undefined;
    restWorld.set(
      bone,
      parentWorld ? parentWorld.multiply(node.rotationQuaternion) : node.rotationQuaternion.clone()
    );
    const short = bone.name.split("_skeleton_")[1];
    if (short && clip.deltas[short]) retargeted++;
  }

  const perFrame = (skeleton.bones.length + 1) * 16;
  const data = new Float32Array(perFrame * CROWD_FRAMES);
  for (let frame = 0; frame < CROWD_FRAMES; frame++) {
    const world = new Map<Bone, Quaternion>();
    for (const bone of chain) {
      const node = nodeOf.get(bone);
      if (!node) continue;
      const parent = bone.getParent();
      const parentWorld = parent ? world.get(parent) : undefined;
      const short = bone.name.split("_skeleton_")[1];
      const track = short && RETARGET.has(short) ? clip.deltas[short] : undefined;

      let newWorld: Quaternion;
      if (track && !BIND_ONLY) {
        const d = track[frame % track.length];
        // Turn this bone as far as the source turned, measured from rest.
        newWorld = new Quaternion(d[0], d[1], d[2], d[3]).multiply(restWorld.get(bone)!);
      } else {
        const rest = restLocal.get(bone)!;
        newWorld = parentWorld ? parentWorld.multiply(rest) : rest.clone();
      }
      world.set(bone, newWorld);
      // Back into this rig's own local space, whatever that happens to be.
      const local = parentWorld ? Quaternion.Inverse(parentWorld).multiply(newWorld) : newWorld;
      node.rotationQuaternion!.copyFrom(local);
    }
    skeleton.prepare(true);
    data.set(skeleton.getTransformMatrices(mesh), frame * perFrame);
  }

  // Widest gap between frame 0 and any other frame. Comparing only against the
  // halfway frame reports no motion for a two-cycle loop, where those frames
  // are identical by construction — a check that quietly passes a still crowd.
  let spread = 0;
  for (let frame = 1; frame < CROWD_FRAMES; frame++) {
    for (let i = 0; i < perFrame; i++) {
      spread = Math.max(spread, Math.abs(data[i] - data[frame * perFrame + i]));
    }
  }
  console.log(
    `baked ${figure.file} as ${figure.clip}: ` +
      `${retargeted}/${skeleton.bones.length} bones retargeted, spread ${spread.toFixed(4)}`
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
