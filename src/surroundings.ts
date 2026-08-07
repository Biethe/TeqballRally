/**
 * The world beyond the venue.
 *
 * The arena models are a fenced site sitting in nothing: past the fence there
 * is sky, and the eye reads that as a diorama on a table however good the
 * court is. This builds what surrounds each one — a city block, parkland, a
 * beach — so the venues feel like places rather than props.
 *
 * All of it is procedural, so it costs no download. Realism at this budget is
 * not detail, which a phone cannot afford and nobody can see past the fence
 * anyway. It comes from three things this module spends its effort on:
 *
 * - **Silhouette and depth.** Buildings at varying heights and distances,
 *   trees at varying scales, a horizon that recedes.
 * - **Haze.** Linear fog toward a colour taken from the sky is what makes
 *   distance read as distance, and it hides the edge of the world for free.
 * - **A sky with a gradient in it.** A flat clear colour is the single most
 *   diorama-like thing in a scene; a graded dome is one unlit mesh.
 *
 * Draw calls are kept down the same way as everywhere else: everything of one
 * colour is merged into one mesh, and anything repeated — trees, cars,
 * windows — is a thin instance.
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
import { loadProps, type PropKind, type PropLibrary } from "./props";
import type { Rgb, Surrounds, Tile, Venue } from "./venue";

/**
 * Which prop families each kind of surroundings uses. Anything not listed is
 * disposed as soon as the shared file has been read, so a beach never pays for
 * twenty houses it will not place.
 */
const PROPS_FOR: Record<Surrounds["kind"], PropKind[]> = {
  city: ["house", "tree", "car"],
  park: ["tree", "bush"],
  beach: ["palm", "bush"],
};

/** Where the venue site ends and this takes over, in metres from the table. */
const SITE_RADIUS = 15.5;
/**
 * The height everything outside the venue stands on.
 *
 * Not `GROUND_Y`, which is the court surface: the arena models sit on a
 * foundation slab whose base is 0.6 m below it, and the world ground goes
 * under that. Anything placed at court height instead floats a metre in the
 * air once it is past the fence — which is exactly what the first pass of
 * parked cars did.
 */
const WORLD_Y = GROUND_Y - 1.05;
/** How far out the world is built. Beyond this, fog. */
const WORLD_RADIUS = 150;

/** Deterministic hash: the same world every run, and on both peers online. */
function noise(a: number, b: number): number {
  const n = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

function surface(scene: Scene, name: string, c: Rgb, emissive = 0.06): StandardMaterial {
  const m = new StandardMaterial(name, scene);
  m.diffuseColor = new Color3(c[0], c[1], c[2]);
  m.emissiveColor = new Color3(c[0] * emissive, c[1] * emissive, c[2] * emissive);
  m.specularColor = new Color3(0.02, 0.02, 0.02);
  return m;
}

/**
 * Put a tiling texture on a material, repeated to match a real-world size.
 *
 * The diffuse *colour* stays white once a texture is on: `diffuseColor`
 * multiplies the texture, so leaving the flat fallback colour in place would
 * tint every photo toward it. The flat colour remains the fallback for a
 * venue with no tile, and for a tile that fails to load.
 *
 * `uScale` is the count of repeats across the mesh, which is the surface's own
 * size divided by how much world one tile covers.
 */
function tiled(
  scene: Scene,
  material: StandardMaterial,
  tile: Tile | undefined,
  surfaceMetres: number
): StandardMaterial {
  if (!tile) return material;
  const texture = new Texture(`/textures/${tile.name}.webp`, scene);
  const repeats = Math.max(1, surfaceMetres / tile.metres);
  texture.uScale = repeats;
  texture.vScale = repeats;
  material.diffuseTexture = texture;
  material.diffuseColor = new Color3(1, 1, 1);
  material.emissiveColor = new Color3(0.05, 0.05, 0.05);
  return material;
}

/** Merge a pile of boxes into one mesh and give it a colour. */
function weld(parts: Mesh[], material: StandardMaterial): Mesh | null {
  if (parts.length === 0) return null;
  const merged = parts.length === 1 ? parts[0] : Mesh.MergeMeshes(parts, true, true);
  if (!merged) return null;
  merged.material = material;
  return merged;
}

/**
 * A graded sky dome.
 *
 * One unlit mesh with vertex colours running from the horizon haze up to the
 * zenith. It is drawn from the inside, has no lighting and no depth writing to
 * worry about because everything else is inside it.
 */
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
    // Ramp over the top half only, and bias it so most of the visible band
    // near the horizon is haze rather than a hard line.
    const t = Math.max(0, Math.min(1, positions[i + 1] / (top || 1)));
    const k = Math.pow(t, 0.55);
    colours[c] = horizon[0] + (zenith[0] - horizon[0]) * k;
    colours[c + 1] = horizon[1] + (zenith[1] - horizon[1]) * k;
    colours[c + 2] = horizon[2] + (zenith[2] - horizon[2]) * k;
    colours[c + 3] = 1;
  }
  dome.setVerticesData(VertexBuffer.ColorKind, colours);
  const mat = new StandardMaterial("skyMat", scene);
  // Unlit, and the gradient rides on the *diffuse* channel: a vertex colour
  // multiplies diffuse, not emissive, so a white emissive dome with vertex
  // colours comes out flat and a black one comes out black.
  mat.disableLighting = true;
  mat.diffuseColor = new Color3(1, 1, 1);
  mat.emissiveColor = new Color3(0, 0, 0);
  mat.backFaceCulling = false;
  // The sky must not be fogged toward itself, and must never occlude anything.
  mat.fogEnabled = false;
  dome.material = mat;
  dome.useVertexColors = true;
  dome.infiniteDistance = true;
  dome.isPickable = false;
  dome.applyFog = false;
  return dome;
}

/** The ground the venue sits on, out to the horizon. */
function buildGround(scene: Scene, c: Rgb, tile: Tile | undefined): Mesh {
  const ground = MeshBuilder.CreateGround(
    "world-ground",
    { width: WORLD_RADIUS * 2, height: WORLD_RADIUS * 2, subdivisions: 1 },
    scene
  );
  // Below everything the venue owns, not just below its court.
  //
  // The arena models sit on a foundation slab whose base is 0.6 m under the
  // playing surface, and a world ground tucked 6 cm under the court was drawn
  // straight over the top of it — the wood grain vanished and every venue
  // became the same sheet of grey. There is a fence around the site, so the
  // step down is not visible from anywhere the game is played from.
  ground.position.y = WORLD_Y;
  ground.material = tiled(
    scene,
    surface(scene, "world-ground-mat", c, 0.1),
    tile,
    WORLD_RADIUS * 2
  );
  ground.isPickable = false;
  return ground;
}

/**
 * Buildings around a city block.
 *
 * Placed on a ring outside the site, in a band rather than a line so the
 * skyline has depth. Windows are a separate merged mesh of small emissive
 * quads — cheaper than a texture and it is what reads as "building" at
 * distance, especially against a dusk sky.
 */
function buildCity(scene: Scene, spec: Surrounds, props: PropLibrary, out: Mesh[]): void {
  const houses = props.get("house") ?? [];
  if (houses.length > 0) {
    // Real buildings in the near ring, where the eye can resolve them, with
    // the procedural blocks pushed out behind to carry the skyline. A street
    // of parked cars and some planting is what makes the near ring read as a
    // street rather than a row of models.
    out.push(
      ...scatterProps(houses, { count: 26, inner: 25, outer: 47, facing: "inward", vary: 0.12, seed: 31, models: 6 })
    );
    out.push(
      ...scatterProps(props.get("car") ?? [], {
        count: 12, inner: 19.5, outer: 21.5, facing: "along", vary: 0.04, seed: 57, models: 4,
      })
    );
    out.push(
      ...scatterProps(props.get("tree") ?? [], {
        count: 24, inner: 18.5, outer: 46, facing: "any", vary: 0.22, seed: 73, models: 5,
      })
    );
  }

  const walls: Mesh[] = [];
  const roofs: Mesh[] = [];
  const windows: Mesh[] = [];
  const wallTones = spec.palette;

  // Behind the houses when there are houses, and taking the near ring itself
  // when the prop file did not load.
  const nearest = houses.length > 0 ? 38 : 14;
  for (let i = 0; i < spec.count; i++) {
    const seed = noise(i, 3);
    const seed2 = noise(i * 7 + 1, 11);
    const angle = (i / spec.count) * Math.PI * 2 + (seed - 0.5) * 0.12;
    const radius = SITE_RADIUS + nearest + seed2 * 54;
    const w = 7 + seed * 9;
    const d = 7 + seed2 * 9;
    // Taller nearer the middle distance, so the skyline is not a wall.
    const h = 6 + seed * 26 * (1 - Math.abs(radius - 40) / 60);
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;

    const body = MeshBuilder.CreateBox(`bldg-${i}`, { width: w, height: h, depth: d }, scene);
    body.position.set(x, WORLD_Y + h / 2, z);
    body.rotation.y = angle;
    walls.push(body);

    const cap = MeshBuilder.CreateBox(`roof-${i}`, { width: w * 1.04, height: 0.5, depth: d * 1.04 }, scene);
    cap.position.set(x, WORLD_Y + h + 0.25, z);
    cap.rotation.y = angle;
    roofs.push(cap);

    // Window grid on the two faces that can be seen from the court.
    const floors = Math.max(1, Math.floor(h / 3.2));
    const bays = Math.max(1, Math.floor(w / 2.6));
    for (let f = 0; f < floors; f++) {
      for (let b = 0; b < bays; b++) {
        if (noise(i * 31 + f, b) > spec.litFraction) continue;
        const pane = MeshBuilder.CreatePlane(`win-${i}-${f}-${b}`, { width: 1.1, height: 1.4 }, scene);
        const bx = (b + 0.5 - bays / 2) * (w / bays);
        pane.position.set(
          x + Math.cos(angle) * bx - Math.sin(angle) * (d / 2 + 0.06),
          WORLD_Y + 2.2 + f * 3.2,
          z + Math.sin(angle) * bx + Math.cos(angle) * (d / 2 + 0.06)
        );
        pane.rotation.y = angle + Math.PI;
        windows.push(pane);
      }
    }
  }

  wallTones.forEach((tone, k) => {
    const mine = walls.filter((_, i) => i % wallTones.length === k);
    // One tile size for every building: they are merged into a single mesh per
    // tone, so the UVs are whatever each box was born with and the repeat has
    // to suit a typical facade rather than any one of them.
    const mesh = weld(
      mine,
      tiled(scene, surface(scene, `city-wall-${k}`, tone, 0.05), spec.wallTile, 24)
    );
    if (mesh) out.push(mesh);
  });
  const roof = weld(roofs, surface(scene, "city-roof", spec.accent, 0.04));
  if (roof) out.push(roof);
  const glass = weld(windows, surface(scene, "city-glass", spec.lit, 0.9));
  if (glass) out.push(glass);
}

/** One tree, merged so a forest of them is a single draw call. */
function treeMesh(scene: Scene, name: string, trunk: Rgb, leaf: Rgb): Mesh {
  const stem = MeshBuilder.CreateCylinder(`${name}-trunk`, { diameterTop: 0.22, diameterBottom: 0.34, height: 2.6, tessellation: 6 }, scene);
  stem.position.y = 1.3;
  const lower = MeshBuilder.CreateSphere(`${name}-a`, { diameter: 3.4, segments: 5 }, scene);
  lower.position.y = 3.4;
  const upper = MeshBuilder.CreateSphere(`${name}-b`, { diameter: 2.4, segments: 5 }, scene);
  upper.position.set(0.5, 4.5, 0.3);
  // Vertex colours rather than three materials: one mesh, one draw call.
  for (const [part, colour] of [
    [stem, trunk],
    [lower, leaf],
    [upper, leaf],
  ] as [Mesh, Rgb][]) {
    const n = part.getTotalVertices();
    const data = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      data[i * 4] = colour[0];
      data[i * 4 + 1] = colour[1];
      data[i * 4 + 2] = colour[2];
      data[i * 4 + 3] = 1;
    }
    part.setVerticesData(VertexBuffer.ColorKind, data);
  }
  return Mesh.MergeMeshes([stem, lower, upper], true, true) ?? stem;
}

/** A palm: a leaning trunk and a crown of fronds. */
function palmMesh(scene: Scene, name: string, trunk: Rgb, leaf: Rgb): Mesh {
  const parts: Mesh[] = [];
  const colours: Rgb[] = [];
  const stem = MeshBuilder.CreateCylinder(`${name}-trunk`, { diameterTop: 0.2, diameterBottom: 0.36, height: 5.2, tessellation: 6 }, scene);
  stem.position.y = 2.6;
  stem.rotation.z = 0.12;
  parts.push(stem);
  colours.push(trunk);
  for (let i = 0; i < 7; i++) {
    const frond = MeshBuilder.CreateBox(`${name}-frond-${i}`, { width: 2.9, height: 0.09, depth: 0.55 }, scene);
    const a = (i / 7) * Math.PI * 2;
    frond.position.set(Math.cos(a) * 1.3 - 0.3, 5.1 - Math.abs(Math.sin(a)) * 0.25, Math.sin(a) * 1.3);
    frond.rotation.set(0, -a, -0.34);
    parts.push(frond);
    colours.push(leaf);
  }
  parts.forEach((part, i) => {
    const n = part.getTotalVertices();
    const data = new Float32Array(n * 4);
    for (let k = 0; k < n; k++) {
      data[k * 4] = colours[i][0];
      data[k * 4 + 1] = colours[i][1];
      data[k * 4 + 2] = colours[i][2];
      data[k * 4 + 3] = 1;
    }
    part.setVerticesData(VertexBuffer.ColorKind, data);
  });
  return Mesh.MergeMeshes(parts, true, true) ?? stem;
}

/** How a scattered prop is turned to face. */
type Facing =
  /** Any which way — trees, bushes, anything with no front. */
  | "any"
  /** Front toward the court: houses look at what they surround. */
  | "inward"
  /** Along the ring, like traffic on a road that curves around the site. */
  | "along";

interface Scatter {
  count: number;
  /** Ring the props are spread between, in metres from the table. */
  inner: number;
  outer: number;
  facing: Facing;
  /** Multiplies the prop's own size; the spread is 1 +/- this. */
  vary: number;
  /** Changes the layout without changing anything else about it. */
  seed: number;
  /**
   * How many distinct models to draw from.
   *
   * This is a draw-call budget, not a variety knob. Every model used is one
   * more draw call however many copies it has, so twenty houses placed from
   * twenty models cost twenty calls and buy nothing a phone can see — six
   * models at varied scale and rotation read the same at forty metres for a
   * third of the cost. The rest are disposed.
   */
  models: number;
}

/**
 * Spread a set of props around the site as thin instances.
 *
 * Props are dealt round-robin from the set so a run of houses is not the same
 * house repeated, and each one collects the instances that fall to it — so a
 * street of forty buildings costs one draw call per distinct model, not forty.
 *
 * Everything is derived from `noise`, never `Math.random`: the same world has
 * to appear on both peers of an online match and in every screenshot run.
 */
function scatterProps(available: Mesh[], spec: Scatter): Mesh[] {
  // Spread the choice across the set rather than taking the first few, so a
  // budget of six houses is six different-looking houses.
  const stride = Math.max(1, Math.floor(available.length / spec.models));
  const props = available.filter((_, i) => i % stride === 0).slice(0, spec.models);
  for (const unused of available) {
    if (!props.includes(unused)) unused.dispose();
  }
  if (props.length === 0) return [];
  const slots: Matrix[][] = props.map(() => []);
  for (let i = 0; i < spec.count; i++) {
    const s = noise(i + spec.seed, spec.seed * 3 + 1);
    const s2 = noise(i * 5 + spec.seed, spec.seed + 7);
    const s3 = noise(i * 13 + spec.seed, spec.seed * 2 + 3);
    const angle = (i / spec.count) * Math.PI * 2 + (s - 0.5) * (Math.PI / spec.count);
    const radius = spec.inner + s2 * (spec.outer - spec.inner);
    const scale = 1 + (s3 - 0.5) * 2 * spec.vary;
    // A house's front is its -z face, so pointing +z outward faces it inward.
    const yaw =
      spec.facing === "any"
        ? s * Math.PI * 2
        : spec.facing === "inward"
          ? Math.PI / 2 - angle + (s3 - 0.5) * 0.25
          : -angle + (s3 < 0.5 ? 0 : Math.PI);
    slots[i % props.length].push(
      Matrix.Compose(
        new Vector3(scale, scale, scale),
        Quaternion.RotationYawPitchRoll(yaw, 0, 0),
        new Vector3(Math.cos(angle) * radius, WORLD_Y, Math.sin(angle) * radius)
      )
    );
  }
  const used: Mesh[] = [];
  props.forEach((prop, i) => {
    const matrices = slots[i];
    if (matrices.length === 0) {
      // A prop nothing was dealt to would otherwise still be drawn, once, at
      // the origin — which is the middle of the court.
      prop.dispose();
      return;
    }
    const buffer = new Float32Array(matrices.length * 16);
    matrices.forEach((m, k) => m.copyToArray(buffer, k * 16));
    prop.thinInstanceSetBuffer("matrix", buffer, 16, true);
    used.push(prop);
  });
  return used;
}

/** Sea, sand and palms. */
function buildBeach(scene: Scene, spec: Surrounds, props: PropLibrary, out: Mesh[]): void {
  // The sea starts beyond the site and runs to the horizon on one side, so
  // there is a shoreline to read rather than a ring of water.
  const sea = MeshBuilder.CreateGround("sea", { width: WORLD_RADIUS * 2, height: WORLD_RADIUS * 1.4 }, scene);
  sea.position.set(0, WORLD_Y + 0.02, -(WORLD_RADIUS * 0.7 + 34));
  const seaMat = tiled(scene, surface(scene, "sea", spec.accent, 0.16), spec.accentTile, WORLD_RADIUS);
  seaMat.specularColor = new Color3(0.35, 0.4, 0.45);
  seaMat.specularPower = 64;
  sea.material = seaMat;
  sea.isPickable = false;
  out.push(sea);

  // A line of foam where they meet.
  const foam = MeshBuilder.CreateGround("foam", { width: WORLD_RADIUS * 2, height: 2.2 }, scene);
  foam.position.set(0, WORLD_Y + 0.04, -34);
  foam.material = surface(scene, "foam", spec.lit, 0.4);
  foam.isPickable = false;
  out.push(foam);

  const palms = props.get("palm") ?? [];
  if (palms.length > 0) {
    // Kept inside the shoreline at z = -34: the ring is a radius, so the far
    // side of a wider one stands in the sea.
    out.push(...scatterProps(palms, { count: spec.count, inner: SITE_RADIUS + 3, outer: 30, facing: "any", vary: 0.2, seed: 12, models: 4 }));
    out.push(
      ...scatterProps(props.get("bush") ?? [], {
        count: 24, inner: SITE_RADIUS + 2, outer: 31, facing: "any", vary: 0.3, seed: 44, models: 2,
      })
    );
    return;
  }

  const palm = palmMesh(scene, "palm", spec.palette[0], spec.palette[1] ?? spec.palette[0]);
  palm.material = surface(scene, "palm-mat", [1, 1, 1], 0.05);
  palm.useVertexColors = true;
  out.push(
    ...scatterProps([palm], { count: spec.count, inner: SITE_RADIUS + 3, outer: 30, facing: "any", vary: 0.3, seed: 4, models: 1 })
  );
}

/** Grass, hedges and trees. */
function buildPark(scene: Scene, spec: Surrounds, props: PropLibrary, out: Mesh[]): void {
  const trees = props.get("tree") ?? [];
  if (trees.length > 0) {
    out.push(
      ...scatterProps(trees, {
        count: spec.count, inner: SITE_RADIUS + 4, outer: SITE_RADIUS + 42, facing: "any", vary: 0.28, seed: 9, models: 6,
      })
    );
    // Undergrowth close in, doing the job the hedge ring below was built for:
    // giving the middle distance something to sit against so the trees do not
    // float on flat green. Real planting beats the box hedge it replaces, so
    // the hedge is now only the fallback's companion.
    out.push(
      ...scatterProps(props.get("bush") ?? [], {
        count: 30, inner: SITE_RADIUS + 2, outer: SITE_RADIUS + 26, facing: "any", vary: 0.35, seed: 63, models: 2,
      })
    );
    return;
  }
  {
    const tree = treeMesh(scene, "tree", spec.palette[0], spec.palette[1] ?? spec.palette[0]);
    tree.material = surface(scene, "tree-mat", [1, 1, 1], 0.05);
    tree.useVertexColors = true;
    out.push(
      ...scatterProps([tree], {
        count: spec.count, inner: SITE_RADIUS + 4, outer: SITE_RADIUS + 42, facing: "any", vary: 0.35, seed: 9, models: 1,
      })
    );
  }

  // A hedge line just outside the fence, for the case where the prop file did
  // not load and the trees are spheres on sticks.
  const hedges: Mesh[] = [];
  const segments = 44;
  for (let i = 0; i < segments; i++) {
    if (noise(i, 21) > 0.72) continue;
    const a = (i / segments) * Math.PI * 2;
    const r = SITE_RADIUS + 2.6;
    const hedge = MeshBuilder.CreateBox(`hedge-${i}`, { width: 3.2, height: 1.5, depth: 1.1 }, scene);
    hedge.position.set(Math.cos(a) * r, WORLD_Y + 0.75, Math.sin(a) * r);
    hedge.rotation.y = -a;
    hedges.push(hedge);
  }
  const hedge = weld(hedges, surface(scene, "hedge", spec.accent, 0.05));
  if (hedge) out.push(hedge);
}

/**
 * Build everything outside the venue, and set the scene's fog and sky to
 * match. Returns the meshes so the caller can freeze them.
 */
export async function buildSurroundings(scene: Scene, venue: Venue): Promise<Mesh[]> {
  const spec = venue.surrounds;
  if (!spec) return [];
  const out: Mesh[] = [];

  out.push(buildSky(scene, spec.horizon, venue.sky));
  out.push(buildGround(scene, spec.ground, spec.groundTile));

  // The modelled props. A venue that cannot fetch them still gets its world,
  // built out of the primitives this module started with.
  const props = await loadProps(scene, PROPS_FOR[spec.kind]).catch((e) => {
    console.warn("Scenery props failed to load:", e);
    return new Map() as PropLibrary;
  });

  if (spec.kind === "city") buildCity(scene, spec, props, out);
  else if (spec.kind === "beach") buildBeach(scene, spec, props, out);
  else buildPark(scene, spec, props, out);

  // Linear fog toward the horizon colour. This is what turns a ring of props
  // into distance, and it hides the edge of the built world entirely.
  scene.fogMode = 1; // FOGMODE_EXP
  scene.fogDensity = spec.haze;
  scene.fogColor = new Color3(spec.horizon[0], spec.horizon[1], spec.horizon[2]);

  for (const m of out) {
    m.isPickable = false;
    if (m.name !== "sky") m.freezeWorldMatrix();
  }
  return out;
}
