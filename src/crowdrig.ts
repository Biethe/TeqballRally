import type { Scene } from "@babylonjs/core/scene";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import type { Bone } from "@babylonjs/core/Bones/bone";
import type { Skeleton } from "@babylonjs/core/Bones/skeleton";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { VertexAnimationBaker } from "@babylonjs/core/BakedVertexAnimation/vertexAnimationBaker";
import { BakedVertexAnimationManager } from "@babylonjs/core/BakedVertexAnimation/bakedVertexAnimationManager";

/**
 * Skinned spectators that cost one draw call each, however many are on screen.
 *
 * A skeleton per spectator is out of the question on the phones this targets,
 * so each figure's motion is baked once into a texture of bone matrices and
 * every copy is a thin instance that reads its own frame out of it. The GPU
 * does the skinning; the CPU does nothing per figure.
 *
 * The clips are written here rather than imported because the pack's Collada
 * shipped its animation arrays empty — see scripts/extract-crowd-figure.py.
 * What survived is better than it sounds: those bind poses are already posed
 * mid-cheer, arms overhead, so a clip only has to move around a pose that
 * already reads as celebrating.
 */

/** Baked at 30 fps; one loop is FRAMES long. */
export const CROWD_FPS = 30;
/** 48 frames is 1.6 s — long enough not to read as a loop, small in texture. */
export const CROWD_FRAMES = 48;

/**
 * Bone rotation axes, measured rather than assumed.
 *
 * Bone local axes differ per rig, so scripts/rigtest.ts rotates each bone
 * about all three and reports where the hand ends up. On this rig it is local
 * Y that swings an arm through the vertical and local Z that leans the spine.
 */
const ARM_AXIS = new Vector3(0, 1, 0);
const SPINE_AXIS = new Vector3(0, 0, 1);

interface Clip {
  /** Bone name suffix, as the pack names them after `_skeleton_`. */
  bone: string;
  axis: Vector3;
  /** Radians at the extremes of the swing. */
  amplitude: number;
  /** Cycles per loop; 2 claps per 1.6 s reads as applause. */
  cycles: number;
  /** Fraction of a cycle this bone lags behind the beat. */
  phase: number;
}

/**
 * Arms pumping overhead with the torso rocking under them.
 *
 * The vertical bounce is deliberately absent: crowd.ts already lifts whole
 * figures by rewriting their instance matrices, and doing it in both places
 * would double the travel.
 */
const CHEER: Clip[] = [
  { bone: "Spine1", axis: SPINE_AXIS, amplitude: 0.08, cycles: 1, phase: 0 },
  { bone: "Spine3", axis: SPINE_AXIS, amplitude: 0.06, cycles: 1, phase: 0.25 },
  { bone: "Neck", axis: SPINE_AXIS, amplitude: 0.07, cycles: 2, phase: 0.3 },
  { bone: "LeftArm", axis: ARM_AXIS, amplitude: 0.38, cycles: 2, phase: 0 },
  { bone: "RightArm", axis: ARM_AXIS, amplitude: 0.38, cycles: 2, phase: 0.5 },
  { bone: "LeftForeArm", axis: ARM_AXIS, amplitude: 0.20, cycles: 2, phase: 0.12 },
  { bone: "RightForeArm", axis: ARM_AXIS, amplitude: 0.20, cycles: 2, phase: 0.62 },
];

/**
 * Bake the loop by computing the bone matrices directly.
 *
 * UNFINISHED — this reconstruction is wrong and this module is not wired into
 * any venue. Baking with every clip removed, which must reproduce the bind
 * pose exactly, still shears the arms into spikes, so the error is in the
 * matrix chain rather than in the animation. Babylon's own
 * `getTransformMatrices` produced correct matrices throughout, so the route
 * back is its `VertexAnimationBaker.bakeVertexData`, whose only real cost is a
 * rendered frame per baked frame.
 *
 * Babylon's bone API fought this at every turn: posing through
 * `setRotationQuaternion` left the bone unchanged, `updateMatrix` with its
 * difference-matrix flag on rewrote the bone's own bind matrices so each frame
 * redefined the rest pose it was moving away from and sheared the limbs into
 * spikes, and with the flag off the pose never reached the matrices the bake
 * reads, so all frames came out identical. Marking bones and skeleton dirty by
 * hand did not bridge it.
 *
 * None of that is needed. What the texture wants per bone is exactly
 * `inverseAbsoluteBind * absolute`, and both the hierarchy and the bind
 * matrices can be read once, up front, while the skeleton is still untouched.
 * Everything after that is plain matrix arithmetic on our own copies, so the
 * skeleton is never mutated and none of its caching applies.
 */
function bakeLoop(skeleton: Skeleton): Float32Array {
  const bones = skeleton.bones;

  // Every bone the hierarchy passes through, not just the ones the skin binds.
  // The skin lists 53 joints while the rig has 68: Hips and the finger tips are
  // absent, so walking only the bound joints drops the transforms in between
  // and leaves the arms shooting off into spikes — visible even with the
  // animation switched off, which is what localised this.
  const all: Bone[] = [];
  const seen = new Set<Bone>();
  for (const bone of bones) {
    for (let node: Bone | null = bone; node && !seen.has(node); node = node.getParent()) {
      seen.add(node);
      all.push(node);
    }
  }

  const depthOf = (bone: Bone): number => {
    let d = 0;
    for (let node = bone.getParent(); node; node = node.getParent()) d++;
    return d;
  };
  all.sort((a, b) => depthOf(a) - depthOf(b));

  const rest = new Map<Bone, { scale: Vector3; rotation: Quaternion; position: Vector3 }>();
  const clips = new Map<Bone, Clip>();
  for (const bone of all) {
    const scale = new Vector3();
    const rotation = new Quaternion();
    const position = new Vector3();
    bone.getLocalMatrix().decompose(scale, rotation, position);
    rest.set(bone, { scale, rotation, position });
    const clip = CHEER.find((c) => bone.name.endsWith(`_skeleton_${c.bone}`));
    if (clip) clips.set(bone, clip);
  }

  // Babylon sizes its matrix array one bone longer than the skeleton, and the
  // texture is built from that length, so the padding has to be there.
  const perFrame = (bones.length + 1) * 16;
  const data = new Float32Array(perFrame * CROWD_FRAMES);
  const absolute = new Map<Bone, Matrix>(all.map((b) => [b, new Matrix()]));
  const local = new Matrix();

  for (let frame = 0; frame < CROWD_FRAMES; frame++) {
    const t = frame / CROWD_FRAMES;
    const base = frame * perFrame;
    for (const bone of all) {
      const clip = clips.get(bone);
      if (clip) {
        const { scale, rotation, position } = rest.get(bone)!;
        const swing = Math.sin((t * clip.cycles + clip.phase) * Math.PI * 2);
        Matrix.ComposeToRef(
          scale,
          rotation.multiply(Quaternion.RotationAxis(clip.axis, swing * clip.amplitude)),
          position,
          local
        );
      } else {
        local.copyFrom(bone.getLocalMatrix());
      }
      const world = absolute.get(bone)!;
      const parent = bone.getParent();
      const parentWorld = parent ? absolute.get(parent) : undefined;
      if (parentWorld) local.multiplyToRef(parentWorld, world);
      else world.copyFrom(local);
    }
    for (let i = 0; i < bones.length; i++) {
      bones[i]
        .getAbsoluteInverseBindMatrix()
        .multiplyToArray(absolute.get(bones[i])!, data, base + i * 16);
    }
    // The padding slot stays identity rather than zero, so anything reading it
    // gets a harmless transform instead of a collapsed one.
    Matrix.IdentityReadOnly.copyToArray(data, base + bones.length * 16);
  }
  return data;
}

/**
 * Where this figure has to be moved to stand on its mark.
 *
 * The pack exported every figure at the seat it occupied in one big
 * grandstand, and that offset is visible in the bind-pose geometry — which is
 * what scattered an earlier crowd across the pitch. It is *not* in the baked
 * result: the bone matrices resolve it, so the skinned figure already stands
 * centred on the origin with its feet on the floor. Measured, not assumed —
 * correcting it a second time moved every spectator by its old seat position.
 */
function groundingMatrix(mesh: Mesh): Matrix {
  mesh.refreshBoundingInfo({ applySkeleton: true });
  const box = mesh.getBoundingInfo().boundingBox;
  return Matrix.Translation(
    -(box.minimum.x + box.maximum.x) / 2,
    -box.minimum.y,
    -(box.minimum.z + box.maximum.z) / 2
  );
}

export interface RiggedFigure {
  mesh: Mesh;
  manager: BakedVertexAnimationManager;
  /** Pre-multiply into each instance matrix: centres the figure and grounds it. */
  grounding: Matrix;
}

/**
 * Load one figure, give it a cheer loop and bake that loop to a texture.
 *
 * Baking is a frame-at-a-time walk over the skeleton, so it is done once at
 * load for the handful of distinct figures — not per spectator.
 */
async function bakeFigure(scene: Scene, file: string): Promise<RiggedFigure | null> {
  const res = await SceneLoader.ImportMeshAsync("", "/models/Crowd/", file, scene);
  const mesh = res.meshes.find((m): m is Mesh => m instanceof Mesh && m.getTotalVertices() > 0);
  const skeleton = res.skeletons[0];
  if (!mesh || !skeleton) {
    for (const m of res.meshes) m.dispose();
    return null;
  }

  // The pack binds its skins with a x100 bind-shape matrix, which the
  // importer parks on the mesh's node. Thin instance matrices are composed
  // with that node's world matrix, so leaving it there multiplies every
  // spectator's position by a hundred and throws the crowd out of the venue.
  // The skinned result is already life-sized in metres without it.
  mesh.parent = null;
  mesh.position.setAll(0);
  mesh.rotationQuaternion = null;
  mesh.rotation.setAll(0);
  mesh.scaling.setAll(1);
  mesh.computeWorldMatrix(true);

  const data = bakeLoop(skeleton);
  // A bake whose frames are all identical looks exactly like "the animation is
  // not playing", which is the failure this went through twice, so it is
  // checked rather than assumed.
  const stride = data.length / CROWD_FRAMES;
  let spread = 0;
  for (let i = 0; i < stride; i++) {
    spread = Math.max(spread, Math.abs(data[i] - data[i + stride * (CROWD_FRAMES >> 1)]));
  }
  if (spread < 1e-4) {
    console.warn(`Crowd figure ${file} baked ${CROWD_FRAMES} identical frames.`);
  }

  const texture = new VertexAnimationBaker(scene, mesh).textureFromBakedVertexData(data);

  const manager = new BakedVertexAnimationManager(scene);
  manager.texture = texture;
  manager.setAnimationParameters(0, CROWD_FRAMES - 1, 0, CROWD_FPS);
  mesh.bakedVertexAnimationManager = manager;

  // The baked matrices are the only pose source from here on, so put the
  // skeleton back where it started and leave it alone.
  mesh.setEnabled(false);
  mesh.alwaysSelectAsActiveMesh = true;
  // The loader's transform nodes are empty now that the mesh has left them.
  for (const node of res.meshes) {
    if (node !== mesh && node.getTotalVertices() === 0) node.dispose();
  }
  return { mesh, manager, grounding: groundingMatrix(mesh) };
}

/**
 * The figures the crowd is built from, loaded in parallel.
 *
 * A figure that fails to load is dropped rather than fatal: a thin crowd is a
 * better outcome than no venue.
 */
export async function loadRiggedFigures(
  scene: Scene,
  files: string[]
): Promise<RiggedFigure[]> {
  const loaded = await Promise.all(
    files.map((f) =>
      bakeFigure(scene, f).catch((e) => {
        console.warn(`Crowd figure ${f} failed:`, e);
        return null;
      })
    )
  );
  return loaded.filter((f): f is RiggedFigure => f !== null);
}

/**
 * Per-instance animation settings: start frame, end frame, offset, speed.
 *
 * The offset is what stops a stand full of spectators clapping in unison —
 * every copy starts somewhere else in the same loop.
 */
export function animationSettingsBuffer(count: number, random: () => number): Float32Array {
  const buffer = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    buffer[i * 4] = 0;
    buffer[i * 4 + 1] = CROWD_FRAMES - 1;
    buffer[i * 4 + 2] = Math.floor(random() * CROWD_FRAMES);
    // A little spread in tempo, so even matched offsets drift apart.
    buffer[i * 4 + 3] = CROWD_FPS * (0.85 + random() * 0.3);
  }
  return buffer;
}

/**
 * Advance every baked figure's clock once per frame.
 *
 * One observer for the whole crowd: the clock is per figure type, not per
 * spectator, and each copy's phase comes from its own instance data.
 */
export function driveCrowdClocks(scene: Scene, figures: RiggedFigure[]): void {
  if (figures.length === 0) return;
  scene.onBeforeRenderObservable.add(() => {
    const dt = scene.getEngine().getDeltaTime() / 1000;
    for (const figure of figures) figure.manager.time += dt;
  });
}
