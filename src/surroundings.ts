/**
 * The world beyond the venue: Green Park, Beach, and City Park.
 *
 * Each environment is constructed with a dedicated, distinctive architectural vision:
 *
 * 1. Green Park ("THE PARK" - Football):
 *    A prestigious championship sports sanctuary with lush rolling lawns, curvilinear
 *    walking/running promenades, deep natural forest tree belts (Plants.glb), ornamental
 *    gardens & hedges, Victorian park lampposts, stone fountains, and teak park benches.
 *    (Zero residential houses, Zero cars).
 *
 * 2. Beach ("THE BASELINE" - Tennis):
 *    An exclusive tropical coastal resort & beach club with golden sand dunes, an expansive
 *    turquoise ocean with foaming surf on the East, a high-end teak wooden boardwalk loop,
 *    an ocean pier extending over the water, a wooden lifeguard tower, swaying coconut palms,
 *    striped parasols, sun loungers, beach towels, surfboards, coastal boulders, and rowboats.
 *    (Zero residential houses, Zero cars).
 *
 * 3. City Park ("THE CAGE" - Basketball):
 *    An iconic downtown metropolitan streetball cage set inside a contemporary paved urban
 *    plaza, framed by high-rise city building blocks and skyscraper facades (Buildings.glb)
 *    in the skyline, modern asphalt perimeter boulevards with authentic road markings & crosswalks,
 *    granite planters, structured street trees, modern streetlights, and steel park benches.
 *    (Zero suburban houses, Zero ugly parked cars).
 */

import type { Scene } from "@babylonjs/core/scene";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { GROUND_Y } from "./config";
import { assetUrl, PROTECTED } from "./protected";
import { loadProps, type PropKind, type PropLibrary } from "./props";
import type { Rgb, Surrounds, Tile, Venue } from "./venue";

/** Which prop families each kind of surroundings uses. */
const PROPS_FOR: Record<Surrounds["kind"], PropKind[]> = {
  city: ["house", "tree", "bush"],
  park: ["tree", "bush"],
  beach: ["palm", "bush"],
};

/** World ground height. */
const WORLD_Y = GROUND_Y - 0.6;
const WORLD_RADIUS = 150;

/** Deterministic pseudo-random noise for reproducible layouts. */
function noise(a: number, b: number): number {
  const n = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

function surface(scene: Scene, name: string, c: Rgb, emissive = 0.08): StandardMaterial {
  const m = new StandardMaterial(name, scene);
  m.diffuseColor = new Color3(c[0], c[1], c[2]);
  m.emissiveColor = new Color3(c[0] * emissive, c[1] * emissive, c[2] * emissive);
  m.specularColor = new Color3(0.04, 0.04, 0.04);
  return m;
}

function tiled(
  scene: Scene,
  material: StandardMaterial,
  tile: Tile | undefined,
  surfaceMetres: number
): StandardMaterial {
  if (!tile) return material;
  const path = `/textures/${tile.name}.webp`;
  const texture = PROTECTED ? new Texture(null, scene) : new Texture(path, scene);
  if (PROTECTED) {
    void assetUrl(path).then((url) => texture.updateURL(url, undefined, undefined, ".webp"));
  }
  const repeats = Math.max(1, surfaceMetres / tile.metres);
  texture.uScale = repeats;
  texture.vScale = repeats;
  material.diffuseTexture = texture;
  material.diffuseColor = new Color3(1, 1, 1);
  material.emissiveColor = new Color3(0.05, 0.05, 0.05);
  return material;
}

function weld(parts: Mesh[], material: StandardMaterial): Mesh | null {
  if (parts.length === 0) return null;
  const merged = parts.length === 1 ? parts[0] : Mesh.MergeMeshes(parts, true, true);
  if (!merged) return null;
  merged.material = material;
  return merged;
}

/** Graded sky dome with horizon haze. */
function buildSky(scene: Scene, horizon: Rgb, zenith: Rgb): Mesh {
  const dome = MeshBuilder.CreateSphere(
    "sky",
    { diameter: WORLD_RADIUS * 2.6, segments: 16, sideOrientation: Mesh.BACKSIDE },
    scene
  );
  const positions = dome.getVerticesData(VertexBuffer.PositionKind) ?? [];
  const colours = new Float32Array((positions.length / 3) * 4);
  let top = 0;
  for (let i = 0; i < positions.length; i += 3) top = Math.max(top, positions[i + 1]);
  for (let i = 0, c = 0; i < positions.length; i += 3, c += 4) {
    const t = Math.max(0, Math.min(1, positions[i + 1] / (top || 1)));
    const k = Math.pow(t, 0.55);
    colours[c] = horizon[0] + (zenith[0] - horizon[0]) * k;
    colours[c + 1] = horizon[1] + (zenith[1] - horizon[1]) * k;
    colours[c + 2] = horizon[2] + (zenith[2] - horizon[2]) * k;
    colours[c + 3] = 1;
  }
  dome.setVerticesData(VertexBuffer.ColorKind, colours);
  const mat = new StandardMaterial("skyMat", scene);
  mat.disableLighting = true;
  mat.diffuseColor = new Color3(1, 1, 1);
  mat.emissiveColor = new Color3(1, 1, 1);
  mat.backFaceCulling = false;
  mat.fogEnabled = false;
  dome.material = mat;
  dome.useVertexColors = true;
  dome.infiniteDistance = true;
  dome.isPickable = false;
  dome.applyFog = false;
  return dome;
}

/** The primary terrain ground plane. */
function buildGround(scene: Scene, c: Rgb, tile: Tile | undefined): Mesh {
  const ground = MeshBuilder.CreateGround(
    "world-ground",
    { width: WORLD_RADIUS * 2, height: WORLD_RADIUS * 2, subdivisions: 1 },
    scene
  );
  ground.position.y = WORLD_Y;
  ground.material = tiled(
    scene,
    surface(scene, "world-ground-mat", c, 0.08),
    tile,
    WORLD_RADIUS * 2
  );
  ground.isPickable = false;
  return ground;
}

// ---------------------------------------------------------------------------
// Protected Site & Clearance Helpers
// ---------------------------------------------------------------------------

/**
 * The 3 outdoor venues (Soccer, Tennis, Basketball) share an arena site
 * footprint of 28.8m (X) x 20.3m (Z) with fences at |X| = 14.4m, |Z| = 10.15m.
 * Everything inside |X| < 14.4, |Z| < 10.15 is the arena itself.
 */
export const SITE_HALF_LEN = 14.4;
export const SITE_HALF_WID = 10.15;

/** Checks if a point is inside the arena site or its immediate buffer. */
export function isInsideSite(x: number, z: number, buffer = 2.0): boolean {
  return (
    Math.abs(x) < SITE_HALF_LEN + buffer &&
    Math.abs(z) < SITE_HALF_WID + buffer
  );
}

/** Batch placement collector for thin instances. */
class PropBatch {
  private slots: Map<Mesh, Matrix[]> = new Map();

  add(
    mesh: Mesh | undefined,
    x: number,
    z: number,
    options?: {
      y?: number;
      yaw?: number;
      pitch?: number;
      roll?: number;
      scale?: number;
      scaleY?: number;
    }
  ): void {
    if (!mesh) return;
    const y = options?.y ?? WORLD_Y;
    const yaw = options?.yaw ?? 0;
    const pitch = options?.pitch ?? 0;
    const roll = options?.roll ?? 0;
    const s = options?.scale ?? 1;
    const sy = options?.scaleY ?? s;

    const m = Matrix.Compose(
      new Vector3(s, sy, s),
      Quaternion.RotationYawPitchRoll(yaw, pitch, roll),
      new Vector3(x, y, z)
    );
    const list = this.slots.get(mesh);
    if (list) list.push(m);
    else this.slots.set(mesh, [m]);
  }

  apply(library: PropLibrary, out: Mesh[]): void {
    for (const meshes of library.values()) {
      for (const mesh of meshes) {
        const matrices = this.slots.get(mesh);
        if (!matrices || matrices.length === 0) {
          mesh.dispose();
          continue;
        }
        const buffer = new Float32Array(matrices.length * 16);
        matrices.forEach((m, idx) => m.copyToArray(buffer, idx * 16));
        mesh.thinInstanceSetBuffer("matrix", buffer, 16, true);
        mesh.thinInstanceCount = matrices.length;
        mesh.thinInstanceRefreshBoundingInfo(true);
        mesh.alwaysSelectAsActiveMesh = true;
        out.push(mesh);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Procedural Geometry & Amenity Builders
// ---------------------------------------------------------------------------

function buildRoundedLoop(
  scene: Scene,
  name: string,
  innerHalfLen: number,
  innerHalfWid: number,
  width: number,
  radius: number,
  y: number,
  material: StandardMaterial,
  segmentsPerCorner = 12
): Mesh {
  const innerPath: Vector3[] = [];
  const outerPath: Vector3[] = [];

  const rx = Math.max(0.5, Math.min(radius, innerHalfLen - 0.5, innerHalfWid - 0.5));
  const cx = innerHalfLen - rx;
  const cz = innerHalfWid - rx;

  const corners = [
    { x: cx, z: -cz, startAngle: -Math.PI / 2, endAngle: 0 },
    { x: cx, z: cz, startAngle: 0, endAngle: Math.PI / 2 },
    { x: -cx, z: cz, startAngle: Math.PI / 2, endAngle: Math.PI },
    { x: -cx, z: -cz, startAngle: Math.PI, endAngle: (Math.PI * 3) / 2 },
  ];

  for (const corner of corners) {
    for (let i = 0; i <= segmentsPerCorner; i++) {
      const t = i / segmentsPerCorner;
      const angle = corner.startAngle + (corner.endAngle - corner.startAngle) * t;
      const cosA = Math.cos(angle);
      const sinA = Math.sin(angle);

      const ix = corner.x + cosA * rx;
      const iz = corner.z + sinA * rx;
      const ox = corner.x + cosA * (rx + width);
      const oz = corner.z + sinA * (rx + width);

      innerPath.push(new Vector3(ix, y, iz));
      outerPath.push(new Vector3(ox, y, oz));
    }
  }

  innerPath.push(innerPath[0].clone());
  outerPath.push(outerPath[0].clone());

  const ribbon = MeshBuilder.CreateRibbon(
    name,
    { pathArray: [innerPath, outerPath], sideOrientation: Mesh.DOUBLESIDE, closePath: true },
    scene
  );
  ribbon.material = material;
  ribbon.isPickable = false;
  return ribbon;
}

function buildStraightSegment(
  scene: Scene,
  name: string,
  x1: number,
  x2: number,
  z1: number,
  z2: number,
  y: number,
  material: StandardMaterial
): Mesh {
  const lenX = Math.abs(x2 - x1);
  const lenZ = Math.abs(z2 - z1);
  const centerX = (x1 + x2) / 2;
  const centerZ = (z1 + z2) / 2;

  const slab = MeshBuilder.CreateBox(
    name,
    { width: Math.max(0.1, lenX), height: 0.02, depth: Math.max(0.1, lenZ) },
    scene
  );
  slab.position.set(centerX, y, centerZ);
  slab.material = material;
  slab.isPickable = false;
  return slab;
}

/** Teak park bench with dark iron legs and armrests. */
function buildBenchMesh(scene: Scene, name: string): Mesh {
  const parts: Mesh[] = [];
  const woodMat = surface(scene, `${name}-wood`, [0.55, 0.34, 0.18], 0.06);
  const metalMat = surface(scene, `${name}-metal`, [0.18, 0.2, 0.24], 0.04);

  for (let i = 0; i < 4; i++) {
    const slat = MeshBuilder.CreateBox(`${name}-seat-${i}`, { width: 1.8, height: 0.04, depth: 0.1 }, scene);
    slat.position.set(0, 0.44, (i - 1.5) * 0.12);
    slat.material = woodMat;
    parts.push(slat);
  }
  for (let i = 0; i < 3; i++) {
    const slat = MeshBuilder.CreateBox(`${name}-back-${i}`, { width: 1.8, height: 0.1, depth: 0.04 }, scene);
    slat.position.set(0, 0.65 + i * 0.12, -0.22);
    slat.material = woodMat;
    parts.push(slat);
  }
  for (const side of [-0.8, 0.8]) {
    const leg = MeshBuilder.CreateBox(`${name}-leg-${side}`, { width: 0.06, height: 0.45, depth: 0.5 }, scene);
    leg.position.set(side, 0.22, 0);
    leg.material = metalMat;
    parts.push(leg);

    const post = MeshBuilder.CreateBox(`${name}-post-${side}`, { width: 0.06, height: 0.45, depth: 0.06 }, scene);
    post.position.set(side, 0.62, -0.22);
    post.material = metalMat;
    parts.push(post);
  }

  const merged = Mesh.MergeMeshes(parts, true, true, undefined, false, true);
  return merged ?? parts[0];
}

/** Victorian park lamppost / lantern. */
function buildLamppost(scene: Scene, name: string): Mesh {
  const parts: Mesh[] = [];
  const metalMat = surface(scene, `${name}-metal`, [0.15, 0.16, 0.18], 0.04);
  const lightMat = surface(scene, `${name}-light`, [1.0, 0.95, 0.8], 0.8);

  const base = MeshBuilder.CreateCylinder(`${name}-base`, { diameterTop: 0.2, diameterBottom: 0.35, height: 0.4 }, scene);
  base.position.y = 0.2;
  base.material = metalMat;
  parts.push(base);

  const pole = MeshBuilder.CreateCylinder(`${name}-pole`, { diameter: 0.1, height: 3.4 }, scene);
  pole.position.y = 1.9;
  pole.material = metalMat;
  parts.push(pole);

  const head = MeshBuilder.CreateBox(`${name}-head`, { width: 0.35, height: 0.45, depth: 0.35 }, scene);
  head.position.y = 3.7;
  head.material = metalMat;
  parts.push(head);

  const glass = MeshBuilder.CreateBox(`${name}-glass`, { width: 0.26, height: 0.32, depth: 0.26 }, scene);
  glass.position.y = 3.7;
  glass.material = lightMat;
  parts.push(glass);

  const merged = Mesh.MergeMeshes(parts, true, true, undefined, false, true);
  return merged ?? parts[0];
}

/** Classic decorative stone park fountain. */
function buildFountain(scene: Scene, name: string): Mesh {
  const parts: Mesh[] = [];
  const stoneMat = surface(scene, `${name}-stone`, [0.72, 0.7, 0.66], 0.08);
  const waterMat = surface(scene, `${name}-water`, [0.2, 0.55, 0.65], 0.25);

  const basin = MeshBuilder.CreateCylinder(`${name}-basin`, { diameter: 5.0, height: 0.5, tessellation: 24 }, scene);
  basin.position.y = 0.25;
  basin.material = stoneMat;
  parts.push(basin);

  const water = MeshBuilder.CreateCylinder(`${name}-water`, { diameter: 4.6, height: 0.05, tessellation: 24 }, scene);
  water.position.y = 0.45;
  water.material = waterMat;
  parts.push(water);

  const pedestal = MeshBuilder.CreateCylinder(`${name}-pedestal`, { diameter: 1.2, height: 1.4 }, scene);
  pedestal.position.y = 0.9;
  pedestal.material = stoneMat;
  parts.push(pedestal);

  const topTier = MeshBuilder.CreateCylinder(`${name}-top`, { diameter: 2.2, height: 0.3 }, scene);
  topTier.position.y = 1.6;
  topTier.material = stoneMat;
  parts.push(topTier);

  const merged = Mesh.MergeMeshes(parts, true, true, undefined, false, true);
  return merged ?? parts[0];
}

/** Resort wooden ocean pier extending into the water. */
function buildOceanPier(scene: Scene, name: string, x1: number, x2: number, z1: number, z2: number): Mesh {
  const parts: Mesh[] = [];
  const woodMat = surface(scene, `${name}-wood`, [0.62, 0.46, 0.32], 0.06);

  const deckW = Math.abs(x2 - x1);
  const deckL = Math.abs(z2 - z1);
  const midX = (x1 + x2) / 2;
  const midZ = (z1 + z2) / 2;

  const deck = MeshBuilder.CreateBox(`${name}-deck`, { width: deckW, height: 0.12, depth: deckL }, scene);
  deck.position.set(midX, WORLD_Y + 0.3, midZ);
  deck.material = woodMat;
  parts.push(deck);

  // Pilings & railing posts
  for (let z = Math.min(z1, z2); z <= Math.max(z1, z2); z += 4.0) {
    for (const x of [x1, x2]) {
      const piling = MeshBuilder.CreateCylinder(`${name}-pile-${x}-${z}`, { diameter: 0.22, height: 2.5 }, scene);
      piling.position.set(x, WORLD_Y - 0.8, z);
      piling.material = woodMat;
      parts.push(piling);

      const post = MeshBuilder.CreateBox(`${name}-post-${x}-${z}`, { width: 0.1, height: 0.9, depth: 0.1 }, scene);
      post.position.set(x, WORLD_Y + 0.75, z);
      post.material = woodMat;
      parts.push(post);
    }
  }

  const merged = Mesh.MergeMeshes(parts, true, true, undefined, false, true);
  return merged ?? parts[0];
}

/** Striped beach umbrella parasol. */
function buildUmbrellaMesh(scene: Scene, name: string, c1: Rgb, c2: Rgb): Mesh {
  const parts: Mesh[] = [];
  const mat1 = surface(scene, `${name}-c1`, c1, 0.14);
  const mat2 = surface(scene, `${name}-c2`, c2, 0.14);
  const poleMat = surface(scene, `${name}-pole`, [0.88, 0.88, 0.9], 0.08);

  const pole = MeshBuilder.CreateCylinder(`${name}-pole`, { diameter: 0.06, height: 2.5 }, scene);
  pole.position.y = 1.25;
  pole.material = poleMat;
  parts.push(pole);

  const canopy = MeshBuilder.CreateCylinder(
    `${name}-canopy`,
    { diameterTop: 0.1, diameterBottom: 2.8, height: 0.55, tessellation: 8 },
    scene
  );
  canopy.position.y = 2.3;
  canopy.material = mat1;
  parts.push(canopy);

  const trim = MeshBuilder.CreateCylinder(
    `${name}-trim`,
    { diameterTop: 2.78, diameterBottom: 2.82, height: 0.15, tessellation: 8 },
    scene
  );
  trim.position.y = 2.05;
  trim.material = mat2;
  parts.push(trim);

  const merged = Mesh.MergeMeshes(parts, true, true, undefined, false, true);
  return merged ?? parts[0];
}

/** Teak beach sunbed lounger with cushion. */
function buildSunLounger(scene: Scene, name: string, cushionColor: Rgb): Mesh {
  const parts: Mesh[] = [];
  const woodMat = surface(scene, `${name}-wood`, [0.65, 0.48, 0.32], 0.06);
  const cushionMat = surface(scene, `${name}-cushion`, cushionColor, 0.1);

  const frame = MeshBuilder.CreateBox(`${name}-frame`, { width: 0.8, height: 0.25, depth: 2.0 }, scene);
  frame.position.y = 0.125;
  frame.material = woodMat;
  parts.push(frame);

  const cushion = MeshBuilder.CreateBox(`${name}-cushion`, { width: 0.72, height: 0.08, depth: 1.9 }, scene);
  cushion.position.y = 0.28;
  cushion.material = cushionMat;
  parts.push(cushion);

  const headrest = MeshBuilder.CreateBox(`${name}-head`, { width: 0.72, height: 0.14, depth: 0.5 }, scene);
  headrest.position.set(0, 0.38, -0.65);
  headrest.rotation.x = -0.35;
  headrest.material = cushionMat;
  parts.push(headrest);

  const merged = Mesh.MergeMeshes(parts, true, true, undefined, false, true);
  return merged ?? parts[0];
}

/** Colorful surfboard planted in sand. */
function buildSurfboard(scene: Scene, name: string, c: Rgb): Mesh {
  const board = MeshBuilder.CreateBox(name, { width: 0.5, height: 2.2, depth: 0.08 }, scene);
  board.material = surface(scene, `${name}-mat`, c, 0.18);
  return board;
}

/** Stilted wooden beach lifeguard watchtower. */
function buildLifeguardTower(scene: Scene, name: string): Mesh {
  const parts: Mesh[] = [];
  const woodMat = surface(scene, `${name}-wood`, [0.85, 0.82, 0.75], 0.08);
  const roofMat = surface(scene, `${name}-roof`, [0.18, 0.42, 0.65], 0.1);

  for (const [x, z] of [[-1.2, -1.2], [1.2, -1.2], [-1.2, 1.2], [1.2, 1.2]]) {
    const post = MeshBuilder.CreateCylinder(`${name}-post-${x}-${z}`, { diameter: 0.18, height: 3.8 }, scene);
    post.position.set(x, 1.9, z);
    post.material = woodMat;
    parts.push(post);
  }

  const floor = MeshBuilder.CreateBox(`${name}-deck`, { width: 3.0, height: 0.15, depth: 3.0 }, scene);
  floor.position.y = 3.2;
  floor.material = woodMat;
  parts.push(floor);

  const cabin = MeshBuilder.CreateBox(`${name}-cabin`, { width: 2.2, height: 1.8, depth: 2.2 }, scene);
  cabin.position.y = 4.15;
  cabin.material = woodMat;
  parts.push(cabin);

  const roof = MeshBuilder.CreateCylinder(`${name}-roof`, { diameterTop: 0.2, diameterBottom: 3.6, height: 0.8, tessellation: 4 }, scene);
  roof.position.y = 5.4;
  roof.rotation.y = Math.PI / 4;
  roof.material = roofMat;
  parts.push(roof);

  const merged = Mesh.MergeMeshes(parts, true, true, undefined, false, true);
  return merged ?? parts[0];
}

/** Beach towel on sand. */
function buildBeachTowel(scene: Scene, name: string, c: Rgb): Mesh {
  const towel = MeshBuilder.CreateBox(name, { width: 1.8, height: 0.01, depth: 0.9 }, scene);
  towel.material = surface(scene, `${name}-mat`, c, 0.1);
  return towel;
}

/** Smooth beach rock boulder. */
function buildRock(scene: Scene, name: string, radius: number): Mesh {
  const rock = MeshBuilder.CreateSphere(name, { diameterX: radius * 2, diameterY: radius * 1.2, diameterZ: radius * 1.6, segments: 4 }, scene);
  rock.material = surface(scene, `${name}-mat`, [0.52, 0.48, 0.44], 0.04);
  return rock;
}

/** Small wooden rowboat resting on the sand shoreline. */
function buildRowboat(scene: Scene, name: string): Mesh {
  const parts: Mesh[] = [];
  const hullMat = surface(scene, `${name}-hull`, [0.42, 0.28, 0.18], 0.05);
  const seatMat = surface(scene, `${name}-seat`, [0.72, 0.6, 0.45], 0.06);

  const hull = MeshBuilder.CreateBox(`${name}-hull`, { width: 3.2, height: 0.6, depth: 1.3 }, scene);
  hull.position.y = 0.3;
  hull.material = hullMat;
  parts.push(hull);

  for (const pos of [-0.8, 0, 0.8]) {
    const seat = MeshBuilder.CreateBox(`${name}-seat-${pos}`, { width: 0.25, height: 0.04, depth: 1.18 }, scene);
    seat.position.set(pos, 0.45, 0);
    seat.material = seatMat;
    parts.push(seat);
  }

  const merged = Mesh.MergeMeshes(parts, true, true, undefined, false, true);
  return merged ?? parts[0];
}

// ---------------------------------------------------------------------------
// Environment 1: GREEN PARK ("THE PARK")
// ---------------------------------------------------------------------------

function buildGreenPark(scene: Scene, _spec: Surrounds, props: PropLibrary, out: Mesh[]): void {
  const pathMat = surface(scene, "park-path-mat", [0.82, 0.78, 0.68], 0.08);

  // 1. Central park promenade surrounding the fence
  const loop = buildRoundedLoop(
    scene,
    "park-loop",
    SITE_HALF_LEN + 1.2, // 15.6m
    SITE_HALF_WID + 1.2, // 11.35m
    3.0,
    4.0,
    WORLD_Y + 0.02,
    pathMat
  );
  out.push(loop);

  // 2. Connecting park avenues
  const southAvenue = buildStraightSegment(scene, "park-south-ave", -(SITE_HALF_LEN + 1.2), -48.0, -1.8, 1.8, WORLD_Y + 0.02, pathMat);
  out.push(southAvenue);

  const northAvenue = buildStraightSegment(scene, "park-north-ave", SITE_HALF_LEN + 1.2, 48.0, -1.8, 1.8, WORLD_Y + 0.02, pathMat);
  out.push(northAvenue);

  const westAvenue = buildStraightSegment(scene, "park-west-ave", -1.8, 1.8, SITE_HALF_WID + 1.2, 40.0, WORLD_Y + 0.02, pathMat);
  out.push(westAvenue);

  const eastAvenue = buildStraightSegment(scene, "park-east-ave", -1.8, 1.8, -(SITE_HALF_WID + 1.2), -40.0, WORLD_Y + 0.02, pathMat);
  out.push(eastAvenue);

  // 3. Central decorative fountain at North trail plaza
  const fountain = buildFountain(scene, "park-fountain");
  fountain.position.set(28.0, WORLD_Y, 0);
  out.push(fountain);

  // 4. Park Lampposts along avenues
  const lampposts: Mesh[] = [];
  const lampPositions = [
    { x: -18.5, z: 2.8 },
    { x: -30.0, z: 2.8 },
    { x: -42.0, z: 2.8 },
    { x: 18.5, z: 2.8 },
    { x: 30.0, z: 2.8 },
    { x: 42.0, z: 2.8 },
    { x: 0, z: 14.5 },
    { x: 0, z: 26.0 },
    { x: 0, z: -14.5 },
    { x: 0, z: -26.0 },
  ];
  for (let i = 0; i < lampPositions.length; i++) {
    const lp = lampPositions[i];
    const lamp = buildLamppost(scene, `park-lamp-${i}`);
    lamp.position.set(lp.x, WORLD_Y, lp.z);
    lampposts.push(lamp);
  }
  const mergedLamps = Mesh.MergeMeshes(lampposts, true, true, undefined, false, true);
  if (mergedLamps) out.push(mergedLamps);

  // 5. Teak park benches along the promenade
  const benches: Mesh[] = [];
  const benchPositions = [
    { x: 6.0, z: 15.0, yaw: -Math.PI / 2 },
    { x: -6.0, z: 15.0, yaw: -Math.PI / 2 },
    { x: 6.0, z: -15.0, yaw: Math.PI / 2 },
    { x: -6.0, z: -15.0, yaw: Math.PI / 2 },
    { x: -19.0, z: 6.0, yaw: 0 },
    { x: -19.0, z: -6.0, yaw: 0 },
    { x: 19.0, z: 6.0, yaw: Math.PI },
    { x: 19.0, z: -6.0, yaw: Math.PI },
  ];
  for (let i = 0; i < benchPositions.length; i++) {
    const bp = benchPositions[i];
    const bench = buildBenchMesh(scene, `park-bench-${i}`);
    bench.position.set(bp.x, WORLD_Y, bp.z);
    bench.rotation.y = bp.yaw;
    benches.push(bench);
  }
  const mergedBenches = Mesh.MergeMeshes(benches, true, true, undefined, false, true);
  if (mergedBenches) out.push(mergedBenches);

  // 6. Realistic Plantings & Forest Belts (Plants.glb) - Clear of the site
  const batch = new PropBatch();
  const trees = props.get("tree") ?? [];
  const bushes = props.get("bush") ?? [];

  if (trees.length > 0) {
    const treeCoords = [
      // North park forest & grove (X >= 22m)
      [26.0, -18.0], [26.0, 18.0], [32.0, -26.0], [34.0, -14.0], [34.0, 14.0], [32.0, 26.0],
      [42.0, -28.0], [44.0, -16.0], [44.0, 0.0], [44.0, 16.0], [42.0, 28.0],
      // South park forest & grove (X <= -22m)
      [-26.0, -18.0], [-26.0, 18.0], [-32.0, -26.0], [-34.0, -14.0], [-34.0, 14.0], [-32.0, 26.0],
      [-42.0, -28.0], [-44.0, -16.0], [-44.0, 0.0], [-44.0, 16.0], [-42.0, 28.0],
      // West perimeter woodland (Z >= 16m)
      [-18.0, 20.0], [-6.0, 22.0], [6.0, 22.0], [18.0, 20.0],
      [-24.0, 32.0], [-12.0, 34.0], [0.0, 35.0], [12.0, 34.0], [24.0, 32.0],
      // East perimeter woodland (Z <= -16m)
      [-18.0, -20.0], [-6.0, -22.0], [6.0, -22.0], [18.0, -20.0],
      [-24.0, -32.0], [-12.0, -34.0], [0.0, -35.0], [12.0, -34.0], [24.0, -32.0],
    ];

    for (let i = 0; i < treeCoords.length; i++) {
      const [tx, tz] = treeCoords[i];
      if (isInsideSite(tx, tz, 4.0)) continue;
      const s = 0.95 + noise(i, 7) * 0.25;
      const yaw = noise(i * 3, 11) * Math.PI * 2;
      batch.add(trees[i % trees.length], tx, tz, { yaw, scale: s });
    }
  }

  // Ornamental hedges and flower beds along paths
  if (bushes.length > 0) {
    const bushCoords = [
      // Symmetrical avenue hedges
      [-20.0, 3.2], [-26.0, 3.2], [-32.0, 3.2], [-38.0, 3.2],
      [-20.0, -3.2], [-26.0, -3.2], [-32.0, -3.2], [-38.0, -3.2],
      [20.0, 3.2], [24.0, 3.2], [32.0, 3.2], [36.0, 3.2],
      [20.0, -3.2], [24.0, -3.2], [32.0, -3.2], [36.0, -3.2],
      // Promenade corner shrubs
      [20.0, 14.5], [20.0, -14.5], [-20.0, 14.5], [-20.0, -14.5],
    ];
    for (let i = 0; i < bushCoords.length; i++) {
      const [bx, bz] = bushCoords[i];
      if (isInsideSite(bx, bz, 3.0)) continue;
      const s = 0.9 + noise(i * 5, 13) * 0.28;
      const yaw = noise(i * 7, 19) * Math.PI * 2;
      batch.add(bushes[i % bushes.length], bx, bz, { yaw, scale: s });
    }
  }

  batch.apply(props, out);
}

// ---------------------------------------------------------------------------
// Environment 2: BEACH ("THE BASELINE")
// ---------------------------------------------------------------------------

function buildBeach(scene: Scene, spec: Surrounds, props: PropLibrary, out: Mesh[]): void {
  const woodMat = surface(scene, "beach-boardwalk-mat", [0.68, 0.52, 0.36], 0.08);

  // 1. Ocean surface on East side (-Z)
  const sea = MeshBuilder.CreateGround("sea", { width: WORLD_RADIUS * 2, height: WORLD_RADIUS }, scene);
  sea.position.set(0, WORLD_Y + 0.02, -(22 + WORLD_RADIUS / 2));
  const seaMat = tiled(scene, surface(scene, "sea-mat", spec.accent, 0.18), spec.accentTile, WORLD_RADIUS);
  seaMat.specularColor = new Color3(0.4, 0.48, 0.55);
  seaMat.specularPower = 48;
  sea.material = seaMat;
  sea.isPickable = false;
  out.push(sea);

  // Foaming surf along the shoreline
  const foam = MeshBuilder.CreateGround("foam", { width: WORLD_RADIUS * 2, height: 2.6 }, scene);
  foam.position.set(0, WORLD_Y + 0.03, -22.0);
  foam.material = surface(scene, "foam-mat", spec.lit, 0.35);
  foam.isPickable = false;
  out.push(foam);

  // 2. Teak Boardwalk loop surrounding the fence
  const boardwalk = buildRoundedLoop(
    scene,
    "beach-boardwalk",
    SITE_HALF_LEN + 1.2,
    SITE_HALF_WID + 1.2,
    3.2,
    4.0,
    WORLD_Y + 0.04,
    woodMat
  );
  out.push(boardwalk);

  // South entrance boardwalk
  const southWalk = buildStraightSegment(scene, "beach-south-walk", -(SITE_HALF_LEN + 1.2), -45.0, -1.8, 1.8, WORLD_Y + 0.04, woodMat);
  out.push(southWalk);

  // 3. Wooden Ocean Pier / Sun Deck extending over the water
  const pier = buildOceanPier(scene, "beach-pier", -4.0, 4.0, -(SITE_HALF_WID + 1.2), -38.0);
  out.push(pier);

  // 4. Stilted Lifeguard Watchtower on the dunes
  const tower = buildLifeguardTower(scene, "beach-tower");
  tower.position.set(-26.0, WORLD_Y, 20.0);
  out.push(tower);

  // 5. Resort Beach Life: Parasols, Loungers, Surfboards, Rowboat, Boulders
  const beachProps: Mesh[] = [];

  // Luxury Beach Lounge 1 (North-East Beachfront)
  const umb1 = buildUmbrellaMesh(scene, "umb-1", [0.88, 0.2, 0.18], [0.94, 0.94, 0.96]);
  umb1.position.set(10.0, WORLD_Y, -17.5);
  beachProps.push(umb1);

  const bed1 = buildSunLounger(scene, "bed-1", [0.92, 0.45, 0.15]);
  bed1.position.set(9.0, WORLD_Y, -18.5);
  bed1.rotation.y = 0.15;
  beachProps.push(bed1);

  const bed2 = buildSunLounger(scene, "bed-2", [0.92, 0.45, 0.15]);
  bed2.position.set(11.0, WORLD_Y, -18.5);
  bed2.rotation.y = -0.15;
  beachProps.push(bed2);

  const towel1 = buildBeachTowel(scene, "towel-1", [0.15, 0.65, 0.85]);
  towel1.position.set(10.0, WORLD_Y + 0.02, -19.8);
  beachProps.push(towel1);

  // Luxury Beach Lounge 2 (South-East Beachfront)
  const umb2 = buildUmbrellaMesh(scene, "umb-2", [0.15, 0.45, 0.75], [0.94, 0.94, 0.96]);
  umb2.position.set(-14.0, WORLD_Y, -17.5);
  beachProps.push(umb2);

  const bed3 = buildSunLounger(scene, "bed-3", [0.18, 0.65, 0.78]);
  bed3.position.set(-13.0, WORLD_Y, -18.5);
  bed3.rotation.y = 0.2;
  beachProps.push(bed3);

  const bed4 = buildSunLounger(scene, "bed-4", [0.18, 0.65, 0.78]);
  bed4.position.set(-15.0, WORLD_Y, -18.5);
  bed4.rotation.y = -0.2;
  beachProps.push(bed4);

  const towel2 = buildBeachTowel(scene, "towel-2", [0.92, 0.35, 0.25]);
  towel2.position.set(-14.0, WORLD_Y + 0.02, -19.8);
  beachProps.push(towel2);

  // Pier deck loungers
  const pierLounger1 = buildSunLounger(scene, "pier-bed-1", [0.94, 0.94, 0.96]);
  pierLounger1.position.set(-2.0, WORLD_Y + 0.35, -28.0);
  pierLounger1.rotation.y = Math.PI / 2;
  beachProps.push(pierLounger1);

  const pierLounger2 = buildSunLounger(scene, "pier-bed-2", [0.94, 0.94, 0.96]);
  pierLounger2.position.set(2.0, WORLD_Y + 0.35, -28.0);
  pierLounger2.rotation.y = -Math.PI / 2;
  beachProps.push(pierLounger2);

  // Surfboards planted in the sand
  const surf1 = buildSurfboard(scene, "surf-1", [0.95, 0.25, 0.15]);
  surf1.position.set(16.0, WORLD_Y + 0.8, -15.0);
  surf1.rotation.set(0.18, 0.4, 0.12);
  beachProps.push(surf1);

  const surf2 = buildSurfboard(scene, "surf-2", [0.15, 0.7, 0.85]);
  surf2.position.set(16.6, WORLD_Y + 0.8, -14.6);
  surf2.rotation.set(0.15, 0.6, -0.08);
  beachProps.push(surf2);

  // Beached wooden rowboat
  const boat = buildRowboat(scene, "beach-boat");
  boat.position.set(24.0, WORLD_Y, -20.0);
  boat.rotation.y = -0.45;
  beachProps.push(boat);

  // Coastal Boulders
  const rockCoords = [
    { x: 20.0, z: -15.0, r: 1.1 },
    { x: -10.0, z: -20.0, r: 1.3 },
    { x: -28.0, z: -20.5, r: 1.6 },
    { x: 22.0, z: 18.0, r: 0.9 },
    { x: -22.0, z: 18.0, r: 0.9 },
  ];
  for (let i = 0; i < rockCoords.length; i++) {
    const rc = rockCoords[i];
    const rock = buildRock(scene, `beach-rock-${i}`, rc.r);
    rock.position.set(rc.x, WORLD_Y + rc.r * 0.4, rc.z);
    rock.rotation.set(noise(i, 3), noise(i, 5), noise(i, 7));
    beachProps.push(rock);
  }

  const mergedBeachProps = Mesh.MergeMeshes(beachProps, true, true, undefined, false, true);
  if (mergedBeachProps) out.push(mergedBeachProps);

  // 6. Tropical Coconut Palms (Props.glb) - Kept well clear of the site
  const batch = new PropBatch();
  const palms = props.get("palm") ?? [];
  const bushes = props.get("bush") ?? [];

  if (palms.length > 0) {
    const palmCoords = [
      // Beachfront shoreline palms (Z <= -17m)
      [18.0, -17.5], [12.0, -18.5], [-8.0, -18.5], [-18.0, -17.5], [-24.0, -18.5],
      // North sandy palms (X >= 22m)
      [24.0, 2.0], [28.0, -8.0], [26.0, 10.0], [32.0, 18.0], [30.0, -14.0],
      // West dune palms (Z >= 18m)
      [16.0, 22.0], [6.0, 24.0], [-6.0, 24.0], [-16.0, 22.0], [-24.0, 24.0],
      [20.0, 32.0], [4.0, 34.0], [-8.0, 34.0], [-20.0, 32.0],
      // South promenade palms (X <= -22m)
      [-26.0, 6.0], [-30.0, -8.0], [-32.0, 12.0], [-34.0, -16.0],
    ];

    for (let i = 0; i < palmCoords.length; i++) {
      const [px, pz] = palmCoords[i];
      if (isInsideSite(px, pz, 3.5)) continue;
      const s = 0.92 + noise(i, 11) * 0.24;
      const yaw = noise(i * 5, 17) * Math.PI * 2;
      batch.add(palms[i % palms.length], px, pz, { yaw, scale: s });
    }
  }

  // Coastal shrubs
  if (bushes.length > 0) {
    const bushCoords = [
      [24.0, 16.0], [18.0, 22.0], [-18.0, 22.0], [-24.0, 16.0],
      [16.0, 12.0], [-16.0, 12.0], [-26.0, 2.0], [-30.0, 2.0],
    ];
    for (let i = 0; i < bushCoords.length; i++) {
      const [bx, bz] = bushCoords[i];
      if (isInsideSite(bx, bz, 2.0)) continue;
      const s = 0.85 + noise(i * 3, 7) * 0.3;
      const yaw = noise(i * 11, 23) * Math.PI * 2;
      batch.add(bushes[i % bushes.length], bx, bz, { yaw, scale: s });
    }
  }

  batch.apply(props, out);
}

// ---------------------------------------------------------------------------
// Environment 3: CITY PARK ("THE CAGE")
// ---------------------------------------------------------------------------

function buildCityPark(scene: Scene, _spec: Surrounds, props: PropLibrary, out: Mesh[]): void {
  const roadMat = surface(scene, "city-road-mat", [0.16, 0.17, 0.2], 0.05);
  const yellowLineMat = surface(scene, "city-yellow-mat", [0.92, 0.76, 0.14], 0.15);
  const whiteLineMat = surface(scene, "city-white-mat", [0.95, 0.95, 0.98], 0.15);
  const sidewalkMat = surface(scene, "city-sidewalk-mat", [0.65, 0.66, 0.7], 0.08);

  const roadParts: Mesh[] = [];
  const yellowParts: Mesh[] = [];
  const whiteParts: Mesh[] = [];
  const sidewalkParts: Mesh[] = [];

  const ROAD_W = 9.0;
  const ROAD_NORTH_X = 38.0;
  const ROAD_SOUTH_X = -38.0;
  const ROAD_WEST_Z = 34.0;
  const ROAD_EAST_Z = -34.0;

  // 1. Perimeter Metropolitan Avenue Loop
  for (const rx of [ROAD_NORTH_X, ROAD_SOUTH_X]) {
    const road = MeshBuilder.CreateBox(`road-x-${rx}`, { width: ROAD_W, height: 0.02, depth: 104 }, scene);
    road.position.set(rx, WORLD_Y + 0.01, 0);
    roadParts.push(road);

    for (let z = -48; z <= 48; z += 4.0) {
      const dash = MeshBuilder.CreateBox(`dash-x-${rx}-${z}`, { width: 0.16, height: 0.022, depth: 2.0 }, scene);
      dash.position.set(rx, WORLD_Y + 0.02, z);
      yellowParts.push(dash);
    }
  }

  for (const rz of [ROAD_WEST_Z, ROAD_EAST_Z]) {
    const road = MeshBuilder.CreateBox(`road-z-${rz}`, { width: 104, height: 0.02, depth: ROAD_W }, scene);
    road.position.set(0, WORLD_Y + 0.01, rz);
    roadParts.push(road);

    for (let x = -48; x <= 48; x += 4.0) {
      const dash = MeshBuilder.CreateBox(`dash-z-${rz}-${x}`, { width: 2.0, height: 0.022, depth: 0.16 }, scene);
      dash.position.set(x, WORLD_Y + 0.02, rz);
      yellowParts.push(dash);
    }
  }

  // Pedestrian Zebra Crosswalks at 4 intersections
  for (const cw of [
    { x: ROAD_NORTH_X, z: ROAD_WEST_Z },
    { x: ROAD_NORTH_X, z: ROAD_EAST_Z },
    { x: ROAD_SOUTH_X, z: ROAD_WEST_Z },
    { x: ROAD_SOUTH_X, z: ROAD_EAST_Z },
  ]) {
    for (let k = -2.8; k <= 2.8; k += 0.9) {
      const stripe = MeshBuilder.CreateBox(`zebra-${cw.x}-${cw.z}-${k}`, { width: ROAD_W - 1.0, height: 0.025, depth: 0.45 }, scene);
      stripe.position.set(cw.x, WORLD_Y + 0.02, cw.z + k);
      whiteParts.push(stripe);
    }
  }

  // 2. Concrete Urban Plaza & Sidewalks surrounding the fence
  const sidewalkHeight = 0.12;

  const courtPlaza = buildRoundedLoop(
    scene,
    "city-court-plaza",
    SITE_HALF_LEN + 1.2,
    SITE_HALF_WID + 1.2,
    3.5,
    4.0,
    WORLD_Y + sidewalkHeight,
    sidewalkMat
  );
  out.push(courtPlaza);

  // Connecting paved avenues from streets to cage
  for (const pos of [
    { x: 26.5, z: 0, w: 14.0, d: 5.0 },
    { x: -26.5, z: 0, w: 14.0, d: 5.0 },
    { x: 0, z: 22.0, w: 5.0, d: 14.0 },
    { x: 0, z: -22.0, w: 5.0, d: 14.0 },
  ]) {
    const walk = MeshBuilder.CreateBox(`plaza-ave-${pos.x}-${pos.z}`, { width: pos.w, height: sidewalkHeight, depth: pos.d }, scene);
    walk.position.set(pos.x, WORLD_Y + sidewalkHeight / 2, pos.z);
    sidewalkParts.push(walk);
  }

  const mergedRoads = weld(roadParts, roadMat);
  if (mergedRoads) out.push(mergedRoads);

  const mergedYellow = weld(yellowParts, yellowLineMat);
  if (mergedYellow) out.push(mergedYellow);

  const mergedWhite = weld(whiteParts, whiteLineMat);
  if (mergedWhite) out.push(mergedWhite);

  const mergedSidewalks = weld(sidewalkParts, sidewalkMat);
  if (mergedSidewalks) out.push(mergedSidewalks);

  // 3. Modern Urban Street Benches
  const benches: Mesh[] = [];
  for (const bp of [
    { x: 6.0, z: 15.0, yaw: -Math.PI / 2 },
    { x: -6.0, z: 15.0, yaw: -Math.PI / 2 },
    { x: 6.0, z: -15.0, yaw: Math.PI / 2 },
    { x: -6.0, z: -15.0, yaw: Math.PI / 2 },
  ]) {
    const bench = buildBenchMesh(scene, `city-bench-${bp.x}-${bp.z}`);
    bench.position.set(bp.x, WORLD_Y + sidewalkHeight, bp.z);
    bench.rotation.y = bp.yaw;
    benches.push(bench);
  }
  const mergedBenches = Mesh.MergeMeshes(benches, true, true, undefined, false, true);
  if (mergedBenches) out.push(mergedBenches);

  // 4. Metropolitan High-Rise Skyline (Buildings.glb) & Street Landscaping
  const batch = new PropBatch();
  const buildings = props.get("house") ?? [];
  const trees = props.get("tree") ?? [];
  const bushes = props.get("bush") ?? [];

  // Frame the park with impressive metropolitan skyscraper/city blocks along the streets
  if (buildings.length > 0) {
    const buildingPositions = [
      // North skyline blocks (behind North avenue)
      { x: 48.0, z: -24.0, yaw: 0, s: 1.2 },
      { x: 48.0, z: 0.0, yaw: 0, s: 1.4 },
      { x: 48.0, z: 24.0, yaw: 0, s: 1.2 },
      // South skyline blocks (behind South avenue)
      { x: -48.0, z: -24.0, yaw: Math.PI, s: 1.2 },
      { x: -48.0, z: 0.0, yaw: Math.PI, s: 1.4 },
      { x: -48.0, z: 24.0, yaw: Math.PI, s: 1.2 },
      // West skyline blocks (behind West avenue)
      { x: -22.0, z: 44.0, yaw: Math.PI / 2, s: 1.3 },
      { x: 0.0, z: 44.0, yaw: Math.PI / 2, s: 1.5 },
      { x: 22.0, z: 44.0, yaw: Math.PI / 2, s: 1.3 },
      // East skyline blocks (behind East avenue)
      { x: -22.0, z: -44.0, yaw: -Math.PI / 2, s: 1.3 },
      { x: 0.0, z: -44.0, yaw: -Math.PI / 2, s: 1.5 },
      { x: 22.0, z: -44.0, yaw: -Math.PI / 2, s: 1.3 },
      // Corner towers
      { x: 48.0, z: 44.0, yaw: Math.PI / 4, s: 1.6 },
      { x: 48.0, z: -44.0, yaw: -Math.PI / 4, s: 1.6 },
      { x: -48.0, z: 44.0, yaw: (Math.PI * 3) / 4, s: 1.6 },
      { x: -48.0, z: -44.0, yaw: (-Math.PI * 3) / 4, s: 1.6 },
    ];

    for (let i = 0; i < buildingPositions.length; i++) {
      const bp = buildingPositions[i];
      const mesh = buildings[i % buildings.length];
      batch.add(mesh, bp.x, bp.z, { yaw: bp.yaw, scale: bp.s });
    }
  }

  // Structured Urban Street Trees aligned along sidewalks (outside the site)
  if (trees.length > 0) {
    const treeCoords = [
      // North sidewalk tree line
      [31.0, -24.0], [31.0, -14.0], [31.0, 14.0], [31.0, 24.0],
      // South sidewalk tree line
      [-31.0, -24.0], [-31.0, -14.0], [-31.0, 14.0], [-31.0, 24.0],
      // West sidewalk tree line
      [-20.0, 27.5], [-10.0, 27.5], [10.0, 27.5], [20.0, 27.5],
      // East sidewalk tree line
      [-20.0, -27.5], [-10.0, -27.5], [10.0, -27.5], [20.0, -27.5],
    ];

    for (let i = 0; i < treeCoords.length; i++) {
      const [tx, tz] = treeCoords[i];
      if (isInsideSite(tx, tz, 4.0)) continue;
      const s = 0.95 + noise(i, 9) * 0.18;
      const yaw = noise(i * 5, 13) * Math.PI * 2;
      batch.add(trees[i % trees.length], tx, tz, { y: WORLD_Y + sidewalkHeight, yaw, scale: s });
    }
  }

  // Ornamental hedges along sidewalks
  if (bushes.length > 0) {
    const bushCoords = [
      [18.0, 16.0], [18.0, -16.0], [-18.0, 16.0], [-18.0, -16.0],
      [22.0, 8.0], [22.0, -8.0], [-22.0, 8.0], [-22.0, -8.0],
    ];
    for (let i = 0; i < bushCoords.length; i++) {
      const [bx, bz] = bushCoords[i];
      if (isInsideSite(bx, bz, 2.0)) continue;
      const s = 0.9 + noise(i * 3, 11) * 0.25;
      const yaw = noise(i * 7, 29) * Math.PI * 2;
      batch.add(bushes[i % bushes.length], bx, bz, { y: WORLD_Y + sidewalkHeight, yaw, scale: s });
    }
  }

  batch.apply(props, out);
}

// ---------------------------------------------------------------------------
// Main Entrypoint: buildSurroundings
// ---------------------------------------------------------------------------

/**
 * Build everything outside the venue, configure the sky and exponential fog.
 * Returns all meshes created so caller can parent and freeze them.
 */
export async function buildSurroundings(scene: Scene, venue: Venue): Promise<Mesh[]> {
  const spec = venue.surrounds;
  if (!spec) return [];
  const out: Mesh[] = [];

  out.push(buildSky(scene, spec.horizon, venue.sky));
  out.push(buildGround(scene, spec.ground, spec.groundTile));

  const props = await loadProps(scene, PROPS_FOR[spec.kind]).catch((e) => {
    console.warn("Scenery props failed to load:", e);
    return new Map() as PropLibrary;
  });

  if (spec.kind === "city") buildCityPark(scene, spec, props, out);
  else if (spec.kind === "beach") buildBeach(scene, spec, props, out);
  else buildGreenPark(scene, spec, props, out);

  // Exponential fog toward horizon
  scene.fogMode = 1; // FOGMODE_EXP
  scene.fogDensity = spec.haze;
  scene.fogColor = new Color3(spec.horizon[0], spec.horizon[1], spec.horizon[2]);

  for (const m of out) {
    m.isPickable = false;
    if (m.name !== "sky") m.freezeWorldMatrix();
  }
  return out;
}



