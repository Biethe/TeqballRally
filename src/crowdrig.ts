import type { Scene } from "@babylonjs/core/scene";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import type { Bone } from "@babylonjs/core/Bones/bone";
import type { Skeleton } from "@babylonjs/core/Bones/skeleton";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Space } from "@babylonjs/core/Maths/math.axis";
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
  { bone: "LeftArm", axis: ARM_AXIS, amplitude: 0.42, cycles: 2, phase: 0 },
  { bone: "RightArm", axis: ARM_AXIS, amplitude: 0.42, cycles: 2, phase: 0.5 },
  { bone: "LeftForeArm", axis: ARM_AXIS, amplitude: 0.22, cycles: 2, phase: 0.12 },
  { bone: "RightForeArm", axis: ARM_AXIS, amplitude: 0.22, cycles: 2, phase: 0.62 },
  { bone: "Spine1", axis: SPINE_AXIS, amplitude: 0.07, cycles: 1, phase: 0 },
  { bone: "Spine3", axis: SPINE_AXIS, amplitude: 0.05, cycles: 1, phase: 0.25 },
  { bone: "Neck", axis: SPINE_AXIS, amplitude: 0.06, cycles: 2, phase: 0.3 },
];

function boneNamed(skeleton: Skeleton, suffix: string): Bone | undefined {
  return skeleton.bones.find((b) => b.name.endsWith(`_skeleton_${suffix}`));
}

/**
 * Pose every animated bone for one frame of the loop.
 *
 * `t` runs 0..1 over the loop, so the sine closes on itself and the last
 * frame meets the first.
 */
function poseAt(posed: { bone: Bone; rest: Quaternion; clip: Clip }[], t: number): void {
  for (const { bone, rest, clip } of posed) {
    const swing = Math.sin((t * clip.cycles + clip.phase) * Math.PI * 2);
    bone.setRotationQuaternion(
      rest.multiply(Quaternion.RotationAxis(clip.axis, swing * clip.amplitude)),
      Space.LOCAL
    );
  }
}

/**
 * Bake the loop by stepping the skeleton directly.
 *
 * Babylon's own baker drives `scene.beginAnimation` one frame at a time and
 * waits for each to finish, which costs a rendered frame per baked frame —
 * seconds of load time for a handful of figures, and worst on the slow phones
 * this is all for. The clip is plain trigonometry here, so the poses can be
 * evaluated in a tight synchronous loop instead and the matrices read straight
 * out of the skeleton.
 */
function bakeLoop(
  mesh: Mesh,
  skeleton: Skeleton,
  posed: { bone: Bone; rest: Quaternion; clip: Clip }[]
): Float32Array {
  skeleton.prepare();
  const perFrame = skeleton.getTransformMatrices(mesh).length;
  const data = new Float32Array(perFrame * CROWD_FRAMES);
  for (let frame = 0; frame < CROWD_FRAMES; frame++) {
    poseAt(posed, frame / CROWD_FRAMES);
    skeleton.prepare();
    data.set(skeleton.getTransformMatrices(mesh), frame * perFrame);
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

  const posed = CHEER.flatMap((clip) => {
    const bone = boneNamed(skeleton, clip.bone);
    return bone ? [{ bone, rest: bone.rotationQuaternion.clone(), clip }] : [];
  });

  const data = bakeLoop(mesh, skeleton, posed);
  const expected = (skeleton.bones.length + 1) * 16 * CROWD_FRAMES;
  if (data.length !== expected) {
    console.warn(`Crowd bake size ${data.length}, expected ${expected}`);
  }
  const texture = new VertexAnimationBaker(scene, mesh).textureFromBakedVertexData(data);

  const manager = new BakedVertexAnimationManager(scene);
  manager.texture = texture;
  manager.setAnimationParameters(0, CROWD_FRAMES - 1, 0, CROWD_FPS);
  mesh.bakedVertexAnimationManager = manager;

  // The baked matrices are the only pose source from here on, so put the
  // skeleton back where it started and leave it alone.
  poseAt(posed, 0);
  skeleton.prepare();

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
