import { Engine } from "@babylonjs/core/Engines/engine";
import { Scene } from "@babylonjs/core/scene";
import { ColorCurves } from "@babylonjs/core/Materials/colorCurves";
import { ImageProcessingConfiguration } from "@babylonjs/core/Materials/imageProcessingConfiguration";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Camera } from "@babylonjs/core/Cameras/camera";
import { TargetCamera } from "@babylonjs/core/Cameras/targetCamera";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import type { Material } from "@babylonjs/core/Materials/material";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshoptCompression } from "@babylonjs/core/Meshes/Compression/meshoptCompression";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import "@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent";
import "@babylonjs/core/Materials/Textures/Loaders/envTextureLoader";
// Register the glTF 2.0 loader only. Every asset in assets/ is a .glb (glTF
// 2.0 binary); pulling the barrel entry would also bundle the glTF 1.0 loader,
// which nothing here can ever use.
import "@babylonjs/loaders/glTF/2.0";
import {
  BALL_RADIUS,
  CAMERA,
  GROUND_Y,
  KIT,
  SERVE_X,
  TAP_PING,
  SPAWN,
  TABLE,
  TABLE_VISUAL,
} from "./config";
import type { QualitySettings } from "./quality";
import { VENUES, type ArenaModel, type CourtStyle, type Rgb, type Venue } from "./venue";
import { buildEnvironment } from "./environment";
import { buildSurroundings } from "./surroundings";
import { importModel } from "./protected";

// Meshopt-compressed GLBs are decoded locally so hosted builds do not depend
// on a third-party CDN just to display a character or the arena.
MeshoptCompression.Configuration = { decoder: { url: "/meshopt_decoder.js" } };
/**
 * How much light each kind of venue gets.
 *
 * The sports hall is lit by its own roof lights and its model carries that
 * brightness in its textures; the outdoor grounds are lit only by these two,
 * and at the hall's levels they read as overcast at dusk. So the lighting
 * follows the venue rather than being one setting for all four.
 */
const INDOOR_LIGHT = { hemi: 0.8, sun: 1.15 };
const OUTDOOR_LIGHT = { hemi: 1.25, sun: 1.75 };


export interface GameScene {
  engine: Engine;
  scene: Scene;
  camera: TargetCamera;
  /** null when the active quality tier renders without shadows. */
  shadows: ShadowGenerator | null;
  /** The tier this scene was built for; the engine's MSAA cannot change later. */
  quality: QualitySettings;
  /**
   * Start (or await) the optional gym backdrop.  The table and procedural
   * court are enough to render the first frame, so the large arena GLB is
   * deliberately deferred until the player leaves the title screen.  Resolves
   * immediately, without downloading anything, on tiers that skip the arena.
   */
  ensureArena: () => Promise<void>;
  /**
   * Swap the venue in place.
   *
   * This used to reload the page, which threw away the player's whole session
   * — menu position, picked character, the lot — for a cosmetic choice. The
   * court, backdrop, dressing and surroundings all hang off one node, so
   * changing venue is disposing that node and building the next one.
   */
  setVenue: (venue: Venue) => Promise<void>;
  /** The venue currently built. */
  currentVenue: () => Venue;
  /** Glowing ring showing where the player's strike will land. */
  aimMarker: Mesh;
  /** Glowing X showing where the airborne ball will first come down. */
  landingMarker: Mesh;
  /** Show a ripple on the ground where a tap landed. */
  pingTap: (x: number, z: number) => void;
  /** Advance that ripple. Wall-clock seconds; presentation, not simulation. */
  stepTapMarker: (dt: number) => void;
  /** Empty the stands. Practice plays to an empty hall. */
  setCrowdVisible: (on: boolean) => void;
}

function mat(scene: Scene, name: string, color: Color3, specular = 0.05): StandardMaterial {
  const m = new StandardMaterial(name, scene);
  m.diffuseColor = color;
  m.specularColor = new Color3(specular, specular, specular);
  return m;
}

export async function createGameScene(
  canvas: HTMLCanvasElement,
  quality: QualitySettings,
  venue: Venue = VENUES.gym
): Promise<GameScene> {
  const engine = new Engine(canvas, true, { stencil: false, antialias: quality.antialias });
  // Hardware scaling is the inverse of the pixel ratio: > 1 renders fewer
  // pixels than the canvas has and upscales. Capping the ratio is the single
  // biggest framerate lever on a fill-rate-bound mobile GPU.
  engine.setHardwareScalingLevel(1 / Math.min(window.devicePixelRatio || 1, quality.maxPixelRatio));
  const scene = new Scene(engine);
  scene.clearColor = new Color4(venue.sky[0], venue.sky[1], venue.sky[2], 1);

  const camera = new TargetCamera("cam", new Vector3(-SPAWN.x - CAMERA.back, GROUND_Y + CAMERA.height, 0), scene);
  camera.setTarget(new Vector3(CAMERA.lookX ?? -0.6, GROUND_Y + CAMERA.lookY, 0));
  camera.minZ = 0.1;

  // Colour grade.
  //
  // Everything in the scene is flat vertex colour under two lights, which on
  // its own renders honest but drab — the venues came out looking washed out
  // on a phone screen. The grade is applied through the materials rather than
  // as a post-process, so it costs shader instructions instead of a
  // full-screen pass, which is the right trade on a fill-rate-bound mobile
  // GPU.
  const grade = scene.imageProcessingConfiguration;
  grade.applyByPostProcess = false;
  // ACES is most of what separates "3D viewport" from "broadcast": highlights
  // roll off instead of clipping, and saturated court colours stop looking
  // like paint. It runs in the same material pass, so it costs shader
  // instructions rather than a full-screen pass. It also darkens, which the
  // exposure below buys back.
  grade.toneMappingEnabled = true;
  grade.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
  grade.contrast = 1.04;
  grade.exposure = 1.32;
  grade.colorCurvesEnabled = true;
  const curves = new ColorCurves();
  // Saturation does the heavy lifting; the warm mid-tone lift keeps skin and
  // wood from going grey under a blue sky. Deliberately restrained — the
  // venues are already painted in strong flat colours, and grading them hard
  // on top turned a sports hall into a cartoon.
  curves.globalSaturation = 8;
  curves.globalHue = 0;
  curves.midtonesSaturation = 7;
  curves.midtonesHue = 5;
  curves.highlightsSaturation = 5;
  curves.shadowsSaturation = 4;
  grade.colorCurves = curves;

  const hemi = new HemisphericLight("hemi", new Vector3(0.2, 1, 0.1), scene);
  hemi.intensity = INDOOR_LIGHT.hemi;
  // A blue-tinted bounce off the ground rather than a grey one: neutral fill
  // is what drains colour out of everything facing away from the sun.
  hemi.groundColor = new Color3(0.16, 0.19, 0.3);

  const sun = new DirectionalLight("sun", new Vector3(-0.35, -1, 0.25), scene);
  sun.position = new Vector3(3, 9, -3);
  sun.intensity = INDOOR_LIGHT.sun;
  sun.diffuse = new Color3(1, 0.96, 0.86);
  let shadows: ShadowGenerator | null = null;
  if (quality.shadowMapSize !== null) {
    shadows = new ShadowGenerator(quality.shadowMapSize, sun);
    // PCF over the old exponential map: the exponential filter smeared every
    // contact into a grey blob, and a player's feet never quite touched the
    // floor. PCF keeps the contact tight at the same map size.
    shadows.usePercentageCloserFiltering = true;
    shadows.filteringQuality = ShadowGenerator.QUALITY_MEDIUM;
    shadows.bias = 0.0012;
    shadows.normalBias = 0.02;
    shadows.darkness = 0.4;
  }

  // A venue that plays on its backdrop's surface still needs a floor painted
  // when that backdrop is never going to arrive — and with no backdrop there
  // is no venue centre line either, so it has to draw its own.
  /**
   * Everything the current venue owns, so the next one can replace it.
   *
   * Anything created while a venue is being built and left without a parent is
   * adopted here, which covers the procedural court, the backdrop's own
   * wrapper, the dressing and the surroundings without each builder having to
   * know about this.
   */
  let venueRoot: TransformNode | null = null;
  /**
   * Materials and textures the venue brought with it.
   *
   * Disposing the node tree is not enough. The crowd's baked animation
   * textures belong to their animation manager rather than to any mesh, so
   * they survive their meshes — measured as roughly thirty textures leaking
   * per swap, which a phone would not survive being played with.
   */
  let venueMaterials: Material[] = [];
  let venueTextures: BaseTexture[] = [];
  let built = venue;

  const buildVenue = async (next: Venue): Promise<void> => {
    if (venueRoot) {
      venueRoot.dispose(false, true);
      venueRoot = null;
      for (const m of venueMaterials) m.dispose(true, true);
      for (const t of venueTextures) t.dispose();
    }
    arenaPromise = null;
    built = next;
    // An enclosed hall and an open-air court are not the same lighting problem,
    // and one setting for both left the outdoor grounds looking overcast.
    const level = next.id === "gym" ? INDOOR_LIGHT : OUTDOOR_LIGHT;
    hemi.intensity = level.hemi;
    sun.intensity = level.sun;
    const root = new TransformNode("venue-root", scene);
    venueRoot = root;
    const before = new Set<unknown>([...scene.meshes, ...scene.transformNodes]);
    const materialsBefore = new Set<Material>(scene.materials);
    const texturesBefore = new Set<BaseTexture>(scene.textures);

    const hasBackdrop = quality.arena && next.arena !== null;
    buildCourt(
      scene,
      hasBackdrop ? next.court : { ...next.court, centreLine: "own" },
      next.court.surface === "own" || !hasBackdrop
    );
    await ensureArena();

    for (const node of [...scene.meshes, ...scene.transformNodes]) {
      if (node !== root && !node.parent && !before.has(node)) node.parent = root;
    }
    venueMaterials = scene.materials.filter((m) => !materialsBefore.has(m));
    venueTextures = scene.textures.filter((t) => !texturesBefore.has(t));
  };

  // The table is small and required for the first playable frame.  The gym
  // backdrop is a 21+ MB GLB, so waiting for it here makes the hosted title
  // screen look frozen on mobile and slower connections.  Keep the promise
  // memoized so title-screen prefetch and match startup can safely race.
  const tableMeshes = await loadTable(scene);
  let arenaPromise: Promise<void> | null = null;
  const ensureArena = (): Promise<void> => {
    // Tiers that skip the backdrop never fetch it: the download, the meshes and
    // their textures are the largest single memory saving available on a phone.
    // The procedural court keeps the venue's palette either way.
    if (!quality.arena || !built.arena) return Promise.resolve();
    const model = built.arena;
    const forVenue = built;
    if (!arenaPromise) {
      // Dressing rides with the backdrop — the tier that skips one skips both
      // — and loads alongside it rather than before, so the board ring and the
      // crowd arrive with the venue instead of holding up the title screen.
      arenaPromise = Promise.all([
        loadArena(scene, model).catch((e) => {
          // The procedural court remains playable if an offline session or a
          // restrictive host cannot fetch the decorative gym model.
          console.warn("Arena failed to load:", e);
        }),
        buildEnvironment(scene, forVenue)
          .then(() => applyCrowdVisibility())
          .catch((e) => {
            console.warn("Venue dressing failed to load:", e);
          }),
        // The world outside the fence. Cheap, procedural and synchronous, but
        // it belongs with the backdrop: without the venue there is nothing for
        // it to stand around.
        Promise.resolve().then(() => buildSurroundings(scene, forVenue)),
      ]).then(() => undefined);
    }
    return arenaPromise;
  };
  for (const m of tableMeshes) {
    m.receiveShadows = true;
    shadows?.addShadowCaster(m, false);
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

  // Landing X: two crossed flat bars, distinct from the orange aim ring. Small
  // on purpose — it marks a spot, and at any size that reads as a shape of its
  // own it starts competing with the ball for the eye.
  const xBar = (name: string, yaw: number): Mesh => {
    const bar = MeshBuilder.CreateBox(name, { width: 0.19, height: 0.012, depth: 0.035 }, scene);
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

  /**
   * The ring that appears where a tap landed.
   *
   * Portrait plays entirely by tapping the ground, and until now a tap
   * produced no acknowledgement at all — the player started walking a moment
   * later and you were left inferring that the game had heard you. A press
   * that shows nothing reads as a press that was missed, which is why the same
   * tap tends to get made twice.
   *
   * It expands and fades over its lifetime rather than blinking, so it reads
   * as a ripple leaving the finger rather than as a UI element switching on.
   */
  const tapMarker = MeshBuilder.CreateTorus(
    "tap-marker",
    { diameter: 0.3, thickness: 0.022, tessellation: 28 },
    scene
  );
  const tapMat = new StandardMaterial("tapMat", scene);
  tapMat.emissiveColor = new Color3(0.35, 0.85, 1);
  tapMat.disableLighting = true;
  tapMat.alpha = 0;
  tapMarker.material = tapMat;
  tapMarker.isPickable = false;
  tapMarker.setEnabled(false);
  let tapAge = TAP_PING.life;

  const pingTap = (x: number, z: number): void => {
    tapMarker.position.set(x, GROUND_Y + 0.02, z);
    tapAge = 0;
    tapMarker.setEnabled(true);
  };

  /**
   * Show or hide every crowd figure at once.
   *
   * Applied to whatever is in the scene now *and* remembered, because a venue
   * can be rebuilt (or arrive late) while the setting stands — a lesson that
   * started in an empty hall must not fill up when the backdrop finishes
   * loading.
   */
  let crowdVisible = true;
  const applyCrowdVisibility = (): void => {
    for (const m of scene.meshes) {
      if ((m.metadata as { crowd?: boolean } | undefined)?.crowd) m.setEnabled(crowdVisible);
    }
  };
  const setCrowdVisible = (on: boolean): void => {
    crowdVisible = on;
    applyCrowdVisibility();
  };

  const stepTapMarker = (dt: number): void => {
    if (tapAge >= TAP_PING.life) return;
    tapAge += dt;
    const t = Math.min(1, tapAge / TAP_PING.life);
    // Fast at first and slowing, the way a ripple actually spreads.
    const grow = 1 - (1 - t) * (1 - t);
    tapMarker.scaling.setAll(TAP_PING.from + (TAP_PING.to - TAP_PING.from) * grow);
    tapMat.alpha = (1 - t) * TAP_PING.alpha;
    if (t >= 1) tapMarker.setEnabled(false);
  };

  // A portrait viewport is narrow, and Babylon's default lens is fixed
  // vertically: keeping the same vertical angle on a tall screen crops the
  // court's width down to a sliver. Portrait therefore pins the field of view
  // horizontally instead — the table and both players stay framed, and the
  // extra height is spent on the arena above and the floor below.
  const frameLens = (): void => {
    const portrait = engine.getRenderWidth() < engine.getRenderHeight();
    camera.fovMode = portrait ? Camera.FOVMODE_HORIZONTAL_FIXED : Camera.FOVMODE_VERTICAL_FIXED;
    camera.fov = portrait ? CAMERA.portrait.fov : CAMERA.fov;
  };
  window.addEventListener("resize", () => {
    engine.resize();
    frameLens();
  });
  frameLens();

  // The first venue is built the same way every later one is, so there is only
  // one path to get wrong.
  await buildVenue(venue);

  return {
    engine,
    scene,
    camera,
    shadows,
    quality,
    ensureArena: () => ensureArena(),
    setVenue: buildVenue,
    currentVenue: () => built,
    aimMarker,
    landingMarker,
    pingTap,
    stepTapMarker,
    setCrowdVisible,
  };
}

/**
 * The floor, the three lines and the perimeter boards.
 *
 * `paintFloor` is false for a venue that plays on its backdrop's own surface,
 * and the caller forces it true when that backdrop is not going to load —
 * lines drawn on nothing would leave the players standing in the void.
 */
function buildCourt(scene: Scene, style: CourtStyle, paintFloor: boolean): void {
  const rgb = (c: Rgb): Color3 => new Color3(c[0], c[1], c[2]);
  const L = style.halfLen;
  const W = style.halfWid;
  if (paintFloor) buildFloor(scene, style, rgb, L, W);
  buildLines(scene, style, rgb, W);
  if (style.boards) buildBoards(scene, style, rgb, L, W);
}

function buildFloor(
  scene: Scene,
  style: CourtStyle,
  rgb: (c: Rgb) => Color3,
  L: number,
  W: number
): void {
  let floor: Mesh;
  if (style.shape === "oval") {
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
  floor.material = mat(scene, "floorMat", rgb(style.floor));
  floor.receiveShadows = true;
  floor.position.y = GROUND_Y;
}

function buildLines(scene: Scene, style: CourtStyle, rgb: (c: Rgb) => Color3, W: number): void {
  const lineMat = mat(scene, "lineMat", rgb(style.line));
  const mkLine = (name: string, w: number, d: number, x: number, z: number) => {
    const l = MeshBuilder.CreateBox(name, { width: w, depth: d, height: 0.012 }, scene);
    l.position.set(x, GROUND_Y + 0.006, z);
    l.material = lineMat;
    return l;
  };
  // Halfway line across the court under the net, and the two service lines.
  // A venue whose own court is already marked at x = 0 draws the halfway line
  // for us — painting a second one only makes a brighter stripe on theirs.
  if (style.centreLine === "own") mkLine("half", 0.05, W * 2, 0, 0);
  mkLine("svc-l", 0.05, 4.2, -(SERVE_X - 0.4), 0);
  mkLine("svc-r", 0.05, 4.2, SERVE_X - 0.4, 0);
}

/** Low boards around the perimeter. */
function buildBoards(
  scene: Scene,
  style: CourtStyle,
  rgb: (c: Rgb) => Color3,
  L: number,
  W: number
): void {
  const surMat = mat(scene, "surMat", rgb(style.board));
  if (style.shape === "oval") {
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

/**
 * Collapse an imported model to one mesh per material.
 *
 * The outdoor venues arrive as 400-720 separate meshes sharing 15-21
 * materials — every bench, railing and floodlight exported as its own node.
 * On a phone the cost of a backdrop is the draw calls, not the triangles: 723
 * calls is over ten times the rest of the scene put together, for geometry
 * that never moves. Merging by material leaves one call per material.
 *
 * Merging happens *before* the wrapper transform, in the model's own space.
 * `MergeMeshes` bakes each source's world matrix into its vertices, so the
 * results are flat meshes that the wrapper then scales and places once — bake
 * afterwards and the normalisation would be applied twice.
 *
 * Returns the meshes now representing the model.
 */
function mergeByMaterial(meshes: AbstractMesh[]): AbstractMesh[] {
  const groups = new Map<string, Mesh[]>();
  const untouched: AbstractMesh[] = [];
  for (const m of meshes) {
    // Skinned or morphed meshes carry per-vertex data a merge would flatten,
    // and anything without geometry (the loader's __root__) has nothing to add.
    //
    // A mesh with instances must be left alone as well, and this one is not
    // obvious: `MergeMeshes` disposes the sources it consumed, and disposing a
    // mesh takes its instances with it. A model whose exporter shared one mesh
    // between many nodes — every bench, every fence panel — would lose all but
    // the first copy of each, which is exactly what merging is supposed to be
    // invisible about.
    const mergeable =
      m instanceof Mesh &&
      m.getTotalVertices() > 0 &&
      m.instances.length === 0 &&
      !m.skeleton &&
      !m.morphTargetManager;
    if (!mergeable) {
      untouched.push(m);
      continue;
    }
    const key = m.material?.uniqueId.toString() ?? "none";
    const group = groups.get(key);
    if (group) group.push(m);
    else groups.set(key, [m]);
  }

  const merged: AbstractMesh[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      merged.push(group[0]);
      continue;
    }
    // allow32BitsIndices: these groups run well past 65k vertices.
    const one = Mesh.MergeMeshes(group, true, true, undefined, false, false);
    if (one) {
      merged.push(one);
    } else {
      // A refusal (mismatched sideOrientation, an instance) is not fatal: the
      // originals are untouched when MergeMeshes returns null.
      merged.push(...group);
    }
  }
  return [...untouched, ...merged];
}

/**
 * Dev flag: `?merge=0` loads the backdrop unmerged. Kept because the merge is
 * only worth having if it draws the same picture, and the honest way to check
 * that is two screenshots from the same machine.
 */
function mergeEnabled(): boolean {
  return new URLSearchParams(location.search).get("merge") !== "0";
}

/** Venue backdrop, normalised to surround the court and grounded at y = 0. */
async function loadArena(scene: Scene, model: ArenaModel): Promise<void> {
  const res = await importModel(scene, "/models/Arena/", model.file);
  const hidden = new Set(model.hideMaterials ?? []);
  const kept = res.meshes.filter((m) => {
    if (!m.material || !hidden.has(m.material.name)) return true;
    m.dispose();
    return false;
  });
  const meshes = mergeEnabled() ? mergeByMaterial(kept) : kept;
  const wrapper = new TransformNode("arena-wrapper", scene);
  for (const m of meshes) if (!m.parent) m.parent = wrapper;
  wrapper.rotation = new Vector3(0, model.rotationY, 0);
  const { min, max } = wrapper.getHierarchyBoundingVectors(true);
  const ext = max.subtract(min);
  const span = Math.max(ext.x, ext.z);
  if (span > 0.01) wrapper.scaling.setAll(model.span / span);
  const b2 = wrapper.getHierarchyBoundingVectors(true);
  const c = b2.max.add(b2.min).scale(0.5);
  // Centre the arena on the table, grounded at y = 0, then apply the tuning offsets.
  wrapper.position.x += model.offsetX - c.x;
  wrapper.position.z += model.offsetZ - c.z;
  wrapper.position.y += model.offsetY - b2.min.y;
  for (const m of meshes) {
    m.isPickable = false;
    m.freezeWorldMatrix();
  }
}

async function loadTable(scene: Scene): Promise<AbstractMesh[]> {
  const res = await importModel(scene, "/models/Ball_and_Table/", "Teqball_Table.glb");
  // The same repair the balls get, for the same reason: the export leaves
  // metallicFactor at glTF's default of 1, and metal with no environment map
  // renders as a black mirror. It is the difference between the centrepiece of
  // every camera angle reading as a teqball table and reading as a burnt slab.
  fixMetallicMaterials(res.meshes);
  // The dark parts must stay dark. Under the outdoor rig the scene carries
  // roughly three suns' worth of light, so the export's charcoal 0.13 renders
  // as mid grey — and the real table in the reference footage is matte
  // near-black, with the white trim and orange legs doing the talking. The
  // albedo is pulled down to survive that light, and the specular sheen is
  // flattened so the top does not read as wet.
  for (const m of res.meshes) {
    const mat = m.material;
    if (mat instanceof PBRMaterial && (mat.name === "Surface1" || mat.name === "Black")) {
      mat.albedoColor = mat.albedoColor.scale(0.4);
      mat.roughness = Math.max(mat.roughness ?? 0, 0.85);
      mat.specularIntensity = 0.35;
    }
  }
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
  OrangeAndBlackBall: "Nike_Pitch_Orange",
};

/** Import a ball file, discard sibling balls bundled in the same export, and wrap it. */
export async function importBall(scene: Scene, file: string): Promise<Mesh> {
  const res = await importModel(scene, "/models/Ball_and_Table/", `${file}.glb`);
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

/**
 * Lift the kit so the players read as a sports broadcast rather than a
 * training session.
 *
 * The source models are photographic and shot for a neutral studio: correct,
 * and muted on a phone held at arm's length in a bright room. Three small
 * changes, applied only to the clothing materials so skin and hair keep their
 * real values:
 *
 * - the albedo is scaled up, which brightens without shifting hue;
 * - the kit's own texture is fed back as a *dim* emissive, which is what stops
 *   the shaded side of a player going grey — the colour survives into shadow
 *   instead of being crushed out of it;
 * - roughness comes down slightly, for the sheen a real shirt has.
 *
 * Deliberately restrained. Pushed further this stops looking like a kit and
 * starts looking like a highlighter, and the emissive in particular is a lie
 * about the lighting that only stays convincing while it is small.
 */
export function brightenKit(meshes: AbstractMesh[]): void {
  const seen = new Set<PBRMaterial>();
  for (const mesh of meshes) {
    const mat = mesh.material;
    if (!(mat instanceof PBRMaterial)) continue;
    if (!KIT_MATERIAL.test(mat.name)) continue;
    if (seen.has(mat)) continue;
    seen.add(mat);
    mat.albedoColor = mat.albedoColor.scale(KIT.lift);
    if (mat.albedoTexture) {
      mat.emissiveTexture = mat.albedoTexture;
      mat.emissiveColor = new Color3(KIT.glow, KIT.glow, KIT.glow);
    }
    mat.roughness = Math.max(KIT.minRoughness, (mat.roughness ?? 1) - KIT.sheen);
  }
}

/** Which materials count as kit. Skin, hair and boots keep their real values. */
const KIT_MATERIAL = /shirt|short|sock|jersey|kit/i;

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
