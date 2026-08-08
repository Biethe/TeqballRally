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
function groundingMatrix(mesh: Mesh): Matrix {
  mesh.refreshBoundingInfo({ applySkeleton: true });
  const box = mesh.getBoundingInfo().boundingBox;
  return Matrix.Translation(
    -(box.minimum.x + box.maximum.x) / 2,
    -box.minimum.y,
    -(box.minimum.z + box.maximum.z) / 2
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
  const mesh = res.meshes.find((m): m is Mesh => m instanceof Mesh && m.getTotalVertices() > 0);
  if (!mesh) {
    for (const m of res.meshes) m.dispose();
    texture.dispose();
    return null;
  }

  // The pack binds its skins with a x100 bind-shape matrix, which the importer
  // parks on the mesh's node. Thin instance matrices compose with that node's
  // world matrix, so leaving it there multiplies every spectator's position by
  // a hundred and throws the crowd out of the venue. The skinned result is
  // already life-sized in metres without it.
  mesh.parent = null;
  mesh.position.setAll(0);
  mesh.rotationQuaternion = null;
  mesh.rotation.setAll(0);
  mesh.scaling.setAll(1);
  mesh.computeWorldMatrix(true);

  const grounding = groundingMatrix(mesh);

  const manager = new BakedVertexAnimationManager(scene);
  manager.texture = texture;
  manager.setAnimationParameters(0, CROWD_FRAMES - 1, 0, CROWD_FPS);
  mesh.bakedVertexAnimationManager = manager;

  mesh.setEnabled(false);
  // A crowd ringing the court is always partly on screen, and its bounding box
  // is the one figure rather than the ring, so leave the culler out of it.
  mesh.alwaysSelectAsActiveMesh = true;
  for (const node of res.meshes) {
    if (node !== mesh && node.getTotalVertices() === 0) node.dispose();
  }
  return { mesh, manager, grounding, spec };
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

/**
 * Advance every figure's clock once per frame.
 *
 * One observer for the whole crowd: the clock is per figure type, not per
 * spectator, and each copy's place in the loop comes from its own instance
 * data.
 */
export function driveCrowdClocks(scene: Scene, figures: RiggedFigure[]): void {
  if (figures.length === 0) return;
  scene.onBeforeRenderObservable.add(() => {
    const dt = scene.getEngine().getDeltaTime() / 1000;
    for (const figure of figures) figure.manager.time += dt;
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
