import { Engine } from "@babylonjs/core/Engines/engine";
import { Scene } from "@babylonjs/core/scene";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { TargetCamera } from "@babylonjs/core/Cameras/targetCamera";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshoptCompression } from "@babylonjs/core/Meshes/Compression/meshoptCompression";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import "@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent";
import "@babylonjs/core/Materials/Textures/Loaders/envTextureLoader";
import "@babylonjs/loaders/glTF";
import { ARENA, BALL_RADIUS, CAMERA, COURT, GROUND_Y, SERVE_X, SPAWN, TABLE, TABLE_VISUAL } from "./config";

// Meshopt-compressed GLBs are decoded locally so hosted builds do not depend
// on a third-party CDN just to display a character or the arena.
MeshoptCompression.Configuration = { decoder: { url: "/meshopt_decoder.js" } };

export interface GameScene {
  engine: Engine;
  scene: Scene;
  camera: TargetCamera;
  shadows: ShadowGenerator;
  /**
   * Start (or await) the optional gym backdrop.  The table and procedural
   * court are enough to render the first frame, so the large arena GLB is
   * deliberately deferred until the player leaves the title screen.
   */
  ensureArena: () => Promise<void>;
  /** Glowing ring showing where the player's strike will land. */
  aimMarker: Mesh;
  /** Glowing X showing where the airborne ball will first come down. */
  landingMarker: Mesh;
}

function mat(scene: Scene, name: string, color: Color3, specular = 0.05): StandardMaterial {
  const m = new StandardMaterial(name, scene);
  m.diffuseColor = color;
  m.specularColor = new Color3(specular, specular, specular);
  return m;
}

export async function createGameScene(canvas: HTMLCanvasElement): Promise<GameScene> {
  const engine = new Engine(canvas, true, { stencil: false, antialias: true });
  engine.setHardwareScalingLevel(1 / Math.min(window.devicePixelRatio || 1, 1.5));
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.045, 0.05, 0.09, 1);

  const camera = new TargetCamera("cam", new Vector3(-SPAWN.x - CAMERA.back, GROUND_Y + CAMERA.height, 0), scene);
  camera.setTarget(new Vector3(0, GROUND_Y + CAMERA.lookY, 0));
  camera.minZ = 0.1;

  const hemi = new HemisphericLight("hemi", new Vector3(0.2, 1, 0.1), scene);
  hemi.intensity = 0.75;
  hemi.groundColor = new Color3(0.18, 0.18, 0.22);

  const sun = new DirectionalLight("sun", new Vector3(-0.35, -1, 0.25), scene);
  sun.position = new Vector3(3, 9, -3);
  sun.intensity = 1.1;
  const lowSpec = new URLSearchParams(location.search).has("light");
  const shadows = new ShadowGenerator(lowSpec ? 256 : 1024, sun);
  shadows.useExponentialShadowMap = true;
  shadows.darkness = 0.45;
  if (lowSpec) shadows.getShadowMap()!.refreshRate = 0; // effectively static

  buildCourt(scene);

  // The table is small and required for the first playable frame.  The gym
  // backdrop is a 21+ MB GLB, so waiting for it here makes the hosted title
  // screen look frozen on mobile and slower connections.  Keep the promise
  // memoized so title-screen prefetch and match startup can safely race.
  const tableMeshes = await loadTable(scene);
  let arenaPromise: Promise<void> | null = null;
  const ensureArena = (): Promise<void> => {
    if (!arenaPromise) {
      arenaPromise = loadArena(scene).catch((e) => {
        // The procedural court remains playable if an offline session or a
        // restrictive host cannot fetch the decorative gym model.
        console.warn("Arena failed to load:", e);
      });
    }
    return arenaPromise;
  };
  for (const m of tableMeshes) {
    m.receiveShadows = true;
    shadows.addShadowCaster(m, false);
  }

  const aimMarker = MeshBuilder.CreateTorus(
    "aim-marker",
    { diameter: 0.34, thickness: 0.03, tessellation: 40 },
    scene
  );
  const aimMat = new StandardMaterial("aimMat", scene);
  aimMat.emissiveColor = new Color3(1, 0.5, 0.1);
  aimMat.disableLighting = true;
  aimMarker.material = aimMat;
  aimMarker.isPickable = false;
  aimMarker.setEnabled(false);

  // Landing X: two crossed flat bars, distinct from the orange aim ring.
  const xBar = (name: string, yaw: number): Mesh => {
    const bar = MeshBuilder.CreateBox(name, { width: 0.3, height: 0.012, depth: 0.05 }, scene);
    bar.rotation.y = yaw;
    bar.bakeCurrentTransformIntoVertices();
    return bar;
  };
  const landingMarker =
    Mesh.MergeMeshes([xBar("lm-a", Math.PI / 4), xBar("lm-b", -Math.PI / 4)], true) ??
    xBar("lm-a", Math.PI / 4);
  landingMarker.name = "landing-marker";
  const landingMat = new StandardMaterial("landingMat", scene);
  landingMat.emissiveColor = new Color3(0.25, 0.85, 1);
  landingMat.disableLighting = true;
  landingMarker.material = landingMat;
  landingMarker.isPickable = false;
  landingMarker.setEnabled(false);

  window.addEventListener("resize", () => {
    engine.resize();
    camera.fov = engine.getRenderWidth() < engine.getRenderHeight() ? 1.1 : 0.85;
  });
  camera.fov = engine.getRenderWidth() < engine.getRenderHeight() ? 1.1 : 0.85;

  return { engine, scene, camera, shadows, ensureArena, aimMarker, landingMarker };
}

function buildCourt(scene: Scene): void {
  if (!COURT.visible) return;
  const L = COURT.floorHalfLen;
  const W = COURT.floorHalfWid;
  let floor: Mesh;
  if (COURT.shape === "oval") {
    // Elliptical floor: a flat disc stretched to the oval's radii, so the
    // court can meet a gymnasium's oval side band without gaps or overshoot.
    floor = MeshBuilder.CreateDisc(
      "floor",
      { radius: 1, tessellation: 96, sideOrientation: Mesh.DOUBLESIDE },
      scene
    );
    floor.rotation.x = -Math.PI / 2; // lay the disc flat
    floor.bakeCurrentTransformIntoVertices();
    floor.scaling.set(L, 1, W);
  } else {
    floor = MeshBuilder.CreateGround("floor", { width: L * 2, height: W * 2 }, scene);
  }
  // Court space: x = table length axis, z = width. Ground "height" maps to z.
  floor.material = mat(scene, "floorMat", new Color3(0.13, 0.22, 0.38));
  floor.receiveShadows = true;
  floor.position.y = GROUND_Y;

  const lineMat = mat(scene, "lineMat", new Color3(0.92, 0.93, 0.95));
  const mkLine = (name: string, w: number, d: number, x: number, z: number) => {
    const l = MeshBuilder.CreateBox(name, { width: w, depth: d, height: 0.012 }, scene);
    l.position.set(x, GROUND_Y + 0.006, z);
    l.material = lineMat;
    return l;
  };
  // Halfway line across the court under the net, and the two service lines.
  mkLine("half", 0.05, COURT.floorHalfWid * 2, 0, 0);
  mkLine("svc-l", 0.05, 4.2, -(SERVE_X - 0.4), 0);
  mkLine("svc-r", 0.05, 4.2, SERVE_X - 0.4, 0);

  // Orange court surrounds (low boards around the perimeter).
  if (!COURT.boards) return;
  const surMat = mat(scene, "surMat", new Color3(0.93, 0.42, 0.08));
  if (COURT.shape === "oval") {
    // Low wall along the floor's elliptical rim: a ribbon between a ground
    // ring and the same ring raised to board height.
    const bottom: Vector3[] = [];
    const top: Vector3[] = [];
    for (let i = 0; i <= 96; i++) {
      const a = (i / 96) * Math.PI * 2;
      const x = Math.cos(a) * L;
      const z = Math.sin(a) * W;
      bottom.push(new Vector3(x, GROUND_Y, z));
      top.push(new Vector3(x, GROUND_Y + 0.55, z));
    }
    const band = MeshBuilder.CreateRibbon(
      "board-ring",
      { pathArray: [bottom, top], sideOrientation: Mesh.DOUBLESIDE },
      scene
    );
    band.material = surMat;
    return;
  }
  const mkBoard = (name: string, w: number, d: number, x: number, z: number) => {
    const b = MeshBuilder.CreateBox(name, { width: w, depth: d, height: 0.55 }, scene);
    b.position.set(x, GROUND_Y + 0.275, z);
    b.material = surMat;
    return b;
  };
  mkBoard("board-n", L * 2 + 0.2, 0.1, 0, W);
  mkBoard("board-s", L * 2 + 0.2, 0.1, 0, -W);
  mkBoard("board-e", 0.1, W * 2 + 0.2, L, 0);
  mkBoard("board-w", 0.1, W * 2 + 0.2, -L, 0);
}

/** Generic arena backdrop, normalised to surround the court and grounded at y = 0. */
async function loadArena(scene: Scene): Promise<void> {
  const res = await SceneLoader.ImportMeshAsync(
    "",
    "/models/Arena/",
    "indoor_arena_inside_out_improved_version.glb",
    scene
  );
  const wrapper = new TransformNode("arena-wrapper", scene);
  for (const m of res.meshes) if (!m.parent) m.parent = wrapper;
  wrapper.rotation = new Vector3(0, ARENA.rotationY, 0);
  const { min, max } = wrapper.getHierarchyBoundingVectors(true);
  const ext = max.subtract(min);
  const span = Math.max(ext.x, ext.z);
  if (span > 0.01) wrapper.scaling.setAll(ARENA.span / span);
  const b2 = wrapper.getHierarchyBoundingVectors(true);
  const c = b2.max.add(b2.min).scale(0.5);
  // Centre the arena on the table, grounded at y = 0, then apply the tuning offsets.
  wrapper.position.x += ARENA.offsetX - c.x;
  wrapper.position.z += ARENA.offsetZ - c.z;
  wrapper.position.y += ARENA.offsetY - b2.min.y;
  for (const m of res.meshes) {
    m.isPickable = false;
    m.freezeWorldMatrix();
  }
}

async function loadTable(scene: Scene): Promise<AbstractMesh[]> {
  const res = await SceneLoader.ImportMeshAsync("", "/models/Ball_and_Table/", "Teqball_Table.glb", scene);
  const wrapper = new TransformNode("table-wrapper", scene);
  for (const m of res.meshes) if (!m.parent) m.parent = wrapper;
  const { min, max } = wrapper.getHierarchyBoundingVectors(true);
  const ext = max.subtract(min);
  // Longest horizontal extent is the 3 m playing length; align it with x.
  if (ext.z > ext.x) wrapper.rotation = new Vector3(0, Math.PI / 2, 0);
  const length = Math.max(ext.x, ext.z);
  const s = (TABLE.length / length) * TABLE_VISUAL.scale;
  wrapper.scaling.setAll(s);
  const b2 = wrapper.getHierarchyBoundingVectors(true);
  const c = b2.max.add(b2.min).scale(0.5);
  wrapper.position.x += TABLE_VISUAL.offsetX - c.x;
  wrapper.position.z += TABLE_VISUAL.offsetZ - c.z;
  wrapper.position.y += GROUND_Y + TABLE_VISUAL.offsetY - b2.min.y;
  return res.meshes.filter((m) => m.getTotalVertices() > 0);
}

// Several ball .glb files are one export containing multiple balls side by side;
// this maps each file to the top-level node of the ball it is named after.
const BALL_KEEP_NODE: Record<string, string> = {
  GreenBall: "Nike_Pitch_Green",
  WhiteBall: "Nike_Pitch_White",
  OrangeAndBlackBall: "Nike_Pitch_Orange",
  OrangeBall: "Nike_Pitch_Orange",
  BlueAndBlackBall: "Nike_Pitch_Blue",
};

/** Import a ball file, discard sibling balls bundled in the same export, and wrap it. */
export async function importBall(scene: Scene, file: string): Promise<Mesh> {
  const res = await SceneLoader.ImportMeshAsync("", "/models/Ball_and_Table/", `${file}.glb`, scene);
  const keep = BALL_KEEP_NODE[file];
  if (keep) {
    const nodes = [...res.transformNodes, ...res.meshes];
    if (nodes.some((n) => n.name === keep)) {
      for (const n of nodes) {
        if (n.name !== keep && n.parent?.name === "__root__") n.dispose(false, true);
      }
    }
  }
  const wrapper = new Mesh(`ball-wrapper-${file}`, scene);
  for (const m of res.meshes) {
    if (!m.isDisposed() && !m.parent) m.parent = wrapper;
  }
  fixMetallicMaterials(wrapper.getChildMeshes());
  return wrapper;
}

/**
 * Several GLB exports omit metallicFactor (glTF defaults it to 1) with low
 * roughness; without an environment map that renders as a dark/black mirror.
 * Turn such materials into matte plastic/cloth so their albedo textures show.
 */
export function fixMetallicMaterials(meshes: AbstractMesh[]): void {
  for (const m of meshes) {
    const mat = m.material;
    if (mat instanceof PBRMaterial && (mat.metallic ?? 1) > 0.99) {
      mat.metallic = 0.05;
      mat.roughness = Math.max(mat.roughness ?? 0, 0.4);
    }
  }
}

/** Load a ball model, normalised to the regulation ball diameter and centred on its origin. */
export async function loadBall(scene: Scene, file: string): Promise<AbstractMesh> {
  const wrapper = await importBall(scene, file);
  const { min, max } = wrapper.getHierarchyBoundingVectors(true);
  const ext = max.subtract(min);
  const d = Math.max(ext.x, ext.y, ext.z);
  if (d > 0.001) wrapper.scaling.setAll((BALL_RADIUS * 2) / d);
  // Re-centre so the wrapper origin is the ball centre.
  const c = max.add(min).scale(0.5);
  for (const n of wrapper.getChildren()) {
    if (n instanceof TransformNode) n.position.subtractInPlace(c);
  }
  return wrapper;
}
