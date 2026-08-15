import type { Scene } from "@babylonjs/core/scene";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import { Matrix } from "@babylonjs/core/Maths/math.vector";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Constants } from "@babylonjs/core/Engines/constants";
import { BakedVertexAnimationManager } from "@babylonjs/core/BakedVertexAnimation/bakedVertexAnimationManager";
import { CROWD_FIGURES, CROWD_FPS, CROWD_FRAMES, type CrowdFigure } from "./crowdclips";

/**
 * Skinned spectators that cost one draw call each, however many are on screen.
 *
 * A skeleton per spectator is out of the question on the phones this targets,
 * so each figure's motion is baked into a texture of bone matrices and every
 * copy is a thin instance reading its own frame out of it. The GPU does the
 * skinning; the CPU does nothing per spectator.
 *
 * The bake happens offline — see scripts/bake-crowd.ts — and ships as a file
 * next to each figure. Baking at load would cost a rendered frame per baked
 * frame, seconds of startup on exactly the phones this is for, and would
 * deadlock outright if the render loop had not started yet.
 */

/**
 * Nearest in both directions, matching what Babylon's own baker builds.
 *
 * A frame is a row of raw matrices; blending between texels would interpolate
 * across unrelated bones and across the loop's seam.
 */
const SAMPLING = Texture.NEAREST_NEAREST;

export interface RiggedFigure {
  mesh: Mesh;
  /**
   * The figure's other drawable pieces, hair especially.
   *
   * These characters are exported as several meshes split by material rather
   * than as one, so taking the first — which is what this did — put 266 of
   * Caleb's 4,763 triangles on screen and left the rest of him behind. They
   * share one skeleton and one baked texture, so every piece takes the same
   * instance matrices; only the draw is separate.
   */
  parts: Mesh[];
  /** Which figure and clip this is, so placement can split by posture. */
  spec: CrowdFigure;
  manager: BakedVertexAnimationManager;
  /** Pre-multiply into each instance matrix: centres the figure and grounds it. */
  grounding: Matrix;
}

/**
 * Where this figure has to be moved to stand on its mark.
 *
 * The pack exported every figure at the seat it occupied in one big
 * grandstand, and that offset rides along in the geometry — which is what
 * scattered an earlier crowd across the pitch. Measured from the posed mesh,
 * since that is the shape actually drawn.
 */
/**
 * How tall a spectator ends up, in metres.
 *
 * Normalised rather than trusted, the way props are. A pack authored in
 * centimetres, or around a different rig height, otherwise puts giants in the
 * stands — and nothing about the placement code would say so.
 */
const CROWD_HEIGHT = 1.74;

/**
 * Centre a figure over the origin, stand it on the floor, and size it.
 *
 * Measured across *every* piece of the figure, which is the whole point. Taken
 * from one mesh it is measured from whichever piece that happens to be, and on
 * these models the largest mesh is the hair: grounding on it put the hair's
 * underside on the floor and buried the rest of the person, which is exactly
 * what the stands looked like.
 */
function groundingMatrix(parts: Mesh[]): Matrix {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const part of parts) {
    part.refreshBoundingInfo({ applySkeleton: true });
    const box = part.getBoundingInfo().boundingBox;
    minX = Math.min(minX, box.minimum.x);
    minY = Math.min(minY, box.minimum.y);
    minZ = Math.min(minZ, box.minimum.z);
    maxX = Math.max(maxX, box.maximum.x);
    maxY = Math.max(maxY, box.maximum.y);
    maxZ = Math.max(maxZ, box.maximum.z);
  }
  const scale = CROWD_HEIGHT / Math.max(0.001, maxY - minY);
  // Centre and ground first, then scale about the origin the feet now sit on,
  // so scaling cannot lift anybody off the floor or push them through it.
  return Matrix.Translation(-(minX + maxX) / 2, -minY, -(minZ + maxZ) / 2).multiply(
    Matrix.Scaling(scale, scale, scale)
  );
}

/** Load one figure's baked matrices and hand back the texture they form. */
async function loadBakedTexture(scene: Scene, file: string): Promise<RawTexture> {
  const response = await fetch(`/models/Crowd/${file.replace(/\.glb$/, "")}.vat`);
  if (!response.ok) throw new Error(`${response.status} fetching baked crowd data`);
  const buffer = await response.arrayBuffer();
  const header = new Uint32Array(buffer, 0, 2);
  const [width, height] = [header[0], header[1]];
  const data = new Float32Array(buffer, 8);
  if (data.length !== width * height * 4) {
    throw new Error(`baked crowd data is ${data.length} floats, expected ${width * height * 4}`);
  }
  return RawTexture.CreateRGBATexture(
    data,
    width,
    height,
    scene,
    false,
    false,
    SAMPLING,
    Constants.TEXTURETYPE_FLOAT
  );
}

async function loadFigure(scene: Scene, spec: CrowdFigure): Promise<RiggedFigure | null> {
  const [res, texture] = await Promise.all([
    SceneLoader.ImportMeshAsync("", "/models/Crowd/", spec.file, scene),
    loadBakedTexture(scene, spec.file),
  ]);
  const drawable = res.meshes.filter(
    (m): m is Mesh => m instanceof Mesh && m.getTotalVertices() > 0
  );
  // Biggest first, so `mesh` is the body rather than an eyelash for anything
  // that wants one representative piece. Grounding does not depend on it — it
  // measures every piece — because on these models the largest mesh is the
  // hair, and grounding on that buried the person wearing it.
  drawable.sort((a, b) => b.getTotalVertices() - a.getTotalVertices());
  const mesh = drawable[0];
  if (!mesh) {
    for (const m of res.meshes) m.dispose();
    texture.dispose();
    return null;
  }

  // Render every piece with no node transform of its own, matching the bake:
  // baked matrices are only valid for the mesh they were taken from, and a
  // piece left under its exported node is animated as though it were somewhere
  // else. Size is put back by the grounding matrix, which normalises it.
  for (const part of drawable) {
    part.parent = null;
    part.position.setAll(0);
    part.rotationQuaternion = null;
    part.rotation.setAll(0);
    part.scaling.setAll(1);
    part.computeWorldMatrix(true);
  }

  const grounding = groundingMatrix(drawable);

  const manager = new BakedVertexAnimationManager(scene);
  manager.texture = texture;
  manager.setAnimationParameters(0, CROWD_FRAMES - 1, 0, CROWD_FPS);
  for (const part of drawable) {
    part.bakedVertexAnimationManager = manager;
    part.setEnabled(false);
    // A crowd ringing the court is always partly on screen, and its bounding
    // box is the one figure rather than the ring, so leave the culler out of it.
    part.alwaysSelectAsActiveMesh = true;
  }
  for (const node of res.meshes) {
    if (!drawable.includes(node as Mesh) && node.getTotalVertices() === 0) node.dispose();
  }
  return { mesh, parts: drawable.slice(1), manager, grounding, spec };
}

/**
 * The figures the crowd is built from, loaded in parallel.
 *
 * A figure that fails is dropped rather than fatal: a thinner crowd is a
 * better outcome than a venue that will not open.
 */
export async function loadRiggedFigures(scene: Scene): Promise<RiggedFigure[]> {
  const loaded = await Promise.all(
    CROWD_FIGURES.map((spec) =>
      loadFigure(scene, spec).catch((e: unknown) => {
        console.warn(`Crowd figure ${spec.file} failed:`, e);
        return null;
      })
    )
  );
  return loaded.filter((f): f is RiggedFigure => f !== null);
}

/** How long the stand stays up after a point. */
const CHEER_SECONDS = 4.5;
/**
 * Seconds spent slowing to a halt at the end of a cheer.
 *
 * Without it the crowd stops on the frame the timer expires, and two hundred
 * people freezing on the same frame is more obviously mechanical than the
 * unbroken celebrating this replaces.
 */
const CHEER_SETTLE = 1.2;

/**
 * Seconds of celebration still owed to the crowd.
 *
 * Module state because a scene has exactly one crowd, and the alternative —
 * threading a handle out through buildEnvironment, whose contract is the meshes
 * it built — would run plumbing through four files to deliver one callback.
 */
let cheerRemaining = 0;

/**
 * Bring the crowd to its feet.
 *
 * Called when a point is awarded. Repeated calls extend rather than restart, so
 * a point during a cheer keeps the stand up instead of resetting its settle.
 */
export function cheerCrowd(seconds: number = CHEER_SECONDS): void {
  cheerRemaining = Math.max(cheerRemaining, seconds);
}

/** Drop the crowd back to stillness immediately — a new match, or a venue swap. */
export function stopCrowdCheer(): void {
  cheerRemaining = 0;
}

/**
 * One step of the crowd's clock: how much celebration is left, and how much of
 * this frame's time the figures should actually advance by.
 *
 * Pure and exported so the settle can be tested without a scene. `advance` is
 * scaled rather than switched off, so the stand slows to a halt instead of
 * every spectator stopping dead on the same frame.
 */
export function crowdClockStep(
  remaining: number,
  dt: number
): { remaining: number; advance: number } {
  if (remaining <= 0) return { remaining: 0, advance: 0 };
  const left = Math.max(0, remaining - dt);
  const settle = Math.min(1, Math.max(0, left / CHEER_SETTLE));
  return { remaining: left, advance: dt * settle };
}

/**
 * Advance every figure's clock once per frame, while there is a reason to.
 *
 * One observer for the whole crowd: the clock is per figure type, not per
 * spectator, and each copy's place in the loop comes from its own instance
 * data.
 *
 * The clock only runs while the crowd is celebrating. A stand where everybody
 * cheers without pause — between points, during a serve, while nothing at all
 * is happening — reads as wallpaper rather than as people. Holding still and
 * then erupting is what makes the eruption worth anything. Each spectator holds
 * a different frame, because their offsets differ, so a still crowd is still a
 * crowd of individuals rather than one pose repeated.
 */
export function driveCrowdClocks(scene: Scene, figures: RiggedFigure[]): void {
  if (figures.length === 0) return;
  scene.onBeforeRenderObservable.add(() => {
    if (cheerRemaining <= 0) return;
    const dt = scene.getEngine().getDeltaTime() / 1000;
    const step = crowdClockStep(cheerRemaining, dt);
    cheerRemaining = step.remaining;
    for (const figure of figures) figure.manager.time += step.advance;
  });
}

/**
 * Per-instance animation settings: start frame, end frame, offset, speed.
 *
 * The offset is what stops a stand full of spectators clapping in unison —
 * every copy starts somewhere else in the same loop — and the slight spread in
 * tempo keeps even matching offsets drifting apart.
 */
export function animationSettingsBuffer(count: number, random: () => number): Float32Array {
  const buffer = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    buffer[i * 4] = 0;
    buffer[i * 4 + 1] = CROWD_FRAMES - 1;
    buffer[i * 4 + 2] = Math.floor(random() * CROWD_FRAMES);
    buffer[i * 4 + 3] = CROWD_FPS * (0.85 + random() * 0.3);
  }
  return buffer;
}
