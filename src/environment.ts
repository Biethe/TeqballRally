/**
 * Procedural set dressing: the things that make a court look like an event.
 *
 * A real teqball match is played inside a ring of lit sponsor boards, with
 * stands close enough that the crowd is part of the picture. None of that is
 * in the venue models — they are empty sports grounds — and none of it needs
 * to be downloaded, because it is all boxes placed around a rectangle or an
 * ellipse. This module builds it from a per-venue palette in `venue.ts`.
 *
 * Everything here is static, so the cost is entirely draw calls:
 *
 * - Ribbon panels are merged into one mesh per colour, so a 60-panel ring
 *   around the court is 3 or 4 calls rather than 60.
 * - Spectators are thin instances — one mesh per shirt colour, one call each,
 *   however many hundred people are sitting there. This is why the crowd is
 *   built out of one repeated shape instead of anything more interesting: a
 *   thin instance costs a matrix, and only the source mesh costs a draw.
 *
 * The whole lot is skipped on the LOW tier, where the venue backdrop is
 * skipped too and the point is to leave the phone alone.
 */

import type { Scene } from "@babylonjs/core/scene";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { GROUND_Y } from "./config";
import { Crowd } from "./crowd";
import type { Dressing, Rgb, Venue } from "./venue";

/** A point on the court's perimeter, with the outward direction it faces. */
interface Edge {
  x: number;
  z: number;
  /** Rotation about the vertical axis that turns a box to face outward. */
  yaw: number;
  /** How much perimeter this point is responsible for. */
  span: number;
}

/**
 * Walk the court's perimeter, whatever shape it is.
 *
 * Both venue court shapes have to hold a ring of boards, and generating the
 * points once here is what lets the rest of the module ignore the difference.
 */
function perimeter(shape: "oval" | "rect", L: number, W: number, count: number): Edge[] {
  const out: Edge[] = [];
  if (shape === "oval") {
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2;
      const next = ((i + 1) / count) * Math.PI * 2;
      const x = Math.cos(a) * L;
      const z = Math.sin(a) * W;
      // Chord length rather than arc: the panel is a straight box.
      const span = Math.hypot(Math.cos(next) * L - x, Math.sin(next) * W - z);
      const mid = (a + next) / 2;
      out.push({
        x: Math.cos(mid) * L,
        z: Math.sin(mid) * W,
        // Tangent of an ellipse is not the tangent of a circle: the normal
        // has to be built from the radii or the panels splay at the ends.
        yaw: Math.atan2(Math.cos(mid) * L, -Math.sin(mid) * W),
        span,
      });
    }
    return out;
  }
  // Rectangle: distribute panels along each side in proportion to its length.
  const sides: { from: [number, number]; to: [number, number]; yaw: number }[] = [
    { from: [-L, W], to: [L, W], yaw: 0 },
    { from: [L, -W], to: [-L, -W], yaw: Math.PI },
    { from: [L, W], to: [L, -W], yaw: Math.PI / 2 },
    { from: [-L, -W], to: [-L, W], yaw: -Math.PI / 2 },
  ];
  const total = 4 * (L + W);
  for (const side of sides) {
    const len = Math.hypot(side.to[0] - side.from[0], side.to[1] - side.from[1]);
    const n = Math.max(1, Math.round((len / total) * count));
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      out.push({
        x: side.from[0] + (side.to[0] - side.from[0]) * t,
        z: side.from[1] + (side.to[1] - side.from[1]) * t,
        yaw: side.yaw,
        span: len / n,
      });
    }
  }
  return out;
}

function flat(scene: Scene, name: string, c: Rgb, emissive = 0.35): StandardMaterial {
  const m = new StandardMaterial(name, scene);
  m.diffuseColor = new Color3(c[0], c[1], c[2]);
  // A little self-illumination: these are lit boards and shirts under
  // floodlights, and without it the ring reads as grey once it faces away
  // from the single directional light.
  m.emissiveColor = new Color3(c[0] * emissive, c[1] * emissive, c[2] * emissive);
  m.specularColor = new Color3(0.04, 0.04, 0.04);
  return m;
}

/**
 * Merge a batch of boxes down to one mesh per colour.
 *
 * The panels differ only in where they sit, so after the transforms are baked
 * there is nothing left to distinguish them and the whole ring can be drawn at
 * once per colour.
 */
function mergeByColour(groups: Map<number, Mesh[]>, materials: StandardMaterial[]): Mesh[] {
  const out: Mesh[] = [];
  for (const [index, parts] of groups) {
    const merged = parts.length === 1 ? parts[0] : Mesh.MergeMeshes(parts, true, true);
    if (!merged) continue;
    merged.material = materials[index];
    out.push(merged);
  }
  return out;
}

/** The ring of lit boards the court sits inside. */
function buildRibbon(
  scene: Scene,
  spec: NonNullable<Dressing["ribbon"]>,
  shape: "oval" | "rect",
  L: number,
  W: number
): Mesh[] {
  const materials = spec.colors.map((c, i) => flat(scene, `ribbon-${i}`, c, 0.5));
  const groups = new Map<number, Mesh[]>();
  const edges = perimeter(shape, L + spec.inset, W + spec.inset, spec.panels);
  edges.forEach((e, i) => {
    const panel = MeshBuilder.CreateBox(
      `ribbon-panel-${i}`,
      // A hair of overlap between neighbours, so a seam never shows as a gap.
      { width: e.span * 1.04, height: spec.height, depth: 0.12 },
      scene
    );
    panel.position.set(e.x, GROUND_Y + spec.height / 2, e.z);
    panel.rotation.y = e.yaw;
    const index = i % materials.length;
    const group = groups.get(index);
    if (group) group.push(panel);
    else groups.set(index, [panel]);
  });
  return mergeByColour(groups, materials);
}

/**
 * Load the crowd library and reduce each person to one drawable mesh.
 *
 * The pack ships each figure split into five materials — hair, head,
 * eyes/mouth, skin, clothes — which is five draw calls per person and useless
 * for instancing. The colours are baked into vertex colours and the five parts
 * merged, so a person becomes one mesh with one material that can be thin
 * instanced.
 *
 * The colours themselves come from the material *names*. The pack's own .mtl
 * is 0.8 grey everywhere, with texture paths pointing at a drive that does not
 * exist, so the only usable colour information in it is which body part each
 * material belongs to — and paired with a per-figure palette that turns out to
 * be enough at the size a spectator is on screen.
 */
export interface CrowdLibrary {
  /** Figures posed standing and cheering. */
  standing: Mesh[];
  /** Figures posed sitting — for benches and bleachers, useless on flat ground. */
  seated: Mesh[];
}

async function loadCrowdLibrary(scene: Scene): Promise<CrowdLibrary> {
  const res = await SceneLoader.ImportMeshAsync("", "/models/Crowd/", "Crowd.glb", scene);

  /**
   * The figure a part belongs to, by walking up to the node the exporter
   * named.
   *
   * Not simply `m.parent`: the compression pass nests a generated `node0`
   * between the named node and its meshes, so the parent is anonymous and the
   * pose tag — the only record of whether a figure is standing or sitting —
   * lives one level further up.
   */
  const figureOf = (m: Mesh): string => {
    for (let node = m.parent; node; node = node.parent) {
      if (node.name.startsWith("stand_") || node.name.startsWith("sit_")) return node.name;
    }
    return m.parent?.name ?? m.name;
  };

  const people = new Map<string, Mesh[]>();
  for (const m of res.meshes) {
    if (!(m instanceof Mesh) || m.getTotalVertices() === 0) continue;
    const who = figureOf(m);
    const group = people.get(who);
    if (group) group.push(m);
    else people.set(who, [m]);
  }

  const shared = new StandardMaterial("crowd-skin", scene);
  shared.diffuseColor = new Color3(1, 1, 1);
  shared.specularColor = new Color3(0.03, 0.03, 0.03);
  // Slight self-illumination so a spectator facing away from the sun is not a
  // silhouette; the crowd is scenery, not something to be read.
  shared.emissiveColor = new Color3(0.1, 0.1, 0.1);

  const library: Mesh[] = [];
  for (const [who, parts] of people) {
    for (const part of parts) {
      const material = part.material;
      const colour =
        material && "albedoColor" in material
          ? (material as unknown as { albedoColor: Color3 }).albedoColor
          : material && "diffuseColor" in material
            ? (material as unknown as { diffuseColor: Color3 }).diffuseColor
            : new Color3(0.7, 0.7, 0.7);
      const count = part.getTotalVertices();
      const colours = new Float32Array(count * 4);
      for (let i = 0; i < count; i++) {
        colours[i * 4] = colour.r;
        colours[i * 4 + 1] = colour.g;
        colours[i * 4 + 2] = colour.b;
        colours[i * 4 + 3] = 1;
      }
      part.setVerticesData(VertexBuffer.ColorKind, colours);
    }
    const merged = parts.length === 1 ? parts[0] : Mesh.MergeMeshes(parts, true, true);
    if (!merged) continue;
    merged.name = `crowd-${who}`;
    merged.material = shared;
    // Vertex colours are a mesh flag rather than a material one, and default
    // to on — set it explicitly so the single shared material cannot be read
    // as the thing that gives everyone the same shirt.
    merged.useVertexColors = true;
    merged.setEnabled(false);
    library.push(merged);
  }

  // One scale for everyone, from the median figure, rather than normalising
  // each to the same height. These are cheering poses: several have their arms
  // straight up, so their bounding box is a head taller than they are, and
  // per-figure normalisation shrinks exactly the people who are celebrating
  // hardest. Grounding stays per figure so nobody floats.
  const heights = library
    .map((m) => {
      const box = m.getBoundingInfo().boundingBox;
      return box.maximum.y - box.minimum.y;
    })
    .sort((a, b) => a - b);
  const median = heights[Math.floor(heights.length / 2)] || 1;
  const scale = SPECTATOR_HEIGHT / median;
  for (const person of library) {
    person.scaling.setAll(scale);
    person.bakeCurrentTransformIntoVertices();
    // Recentre on the figure's own footprint, not just the floor.
    //
    // The pack is one grandstand, and each figure was exported at the seat it
    // occupies in it. `MergeMeshes` bakes world matrices into vertices, so
    // that seat position survives as an offset inside the geometry — and a
    // thin instance placed at the touchline then lands at
    // touchline-plus-seat, which scattered a third of the crowd across the
    // pitch. Only the vertical was being corrected before.
    const box = person.getBoundingInfo().boundingBox;
    person.position.set(
      -(box.minimum.x + box.maximum.x) / 2,
      -box.minimum.y,
      -(box.minimum.z + box.maximum.z) / 2
    );
    person.bakeCurrentTransformIntoVertices();
  }
  const standing = library.filter((m) => m.name.includes("stand_"));
  const seated = library.filter((m) => m.name.includes("sit_"));
  return { standing, seated };
}

/** How tall a spectator stands, in metres, against ~1.45 m players. */
const SPECTATOR_HEIGHT = 1.42;

/**
 * People watching, in rows behind the board ring along both long sides.
 *
 * They stand on the ground rather than on tiered decks. These are outdoor
 * grounds the size of a schoolyard; a grandstand around one looks like a
 * mistake, and the decks also buried the benches and fences the models
 * already have. One dense row of onlookers reads as a crowd at a street game,
 * which is what these venues are.
 *
 * Each distinct figure is thin instanced, so the crowd costs one draw call per
 * figure used rather than one per person. The jitter is deterministic — a hash
 * of the position rather than Math.random — so the crowd is identical on both
 * peers of an online match and identical between runs when comparing
 * screenshots.
 */
function placeCrowd(
  spec: NonNullable<Dressing["crowd"]>,
  library: Mesh[],
  L: number,
  W: number,
  into: Placement
): void {
  if (library.length === 0) return;

  // A cheap deterministic hash: same spot, same person, every time.
  const noise = (a: number, b: number): number => {
    const n = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
    return n - Math.floor(n);
  };

  for (const side of [1, -1]) {
    for (let row = 0; row < spec.rows; row++) {
      const z = side * (W + spec.gap + row * spec.spacing);
      const count = Math.round((L * 2) / spec.spacing);
      for (let i = 0; i < count; i++) {
        const seed = noise(i * 3 + row * 17, side * 7);
        // Leave gaps. An unbroken row of people is the other way this reads
        // as a pattern rather than a crowd.
        if (seed > spec.density) continue;
        const jitter = noise(i, row * 5 + side * 11);
        const x = (i + 0.5 - count / 2) * spec.spacing + (jitter - 0.5) * spec.spacing * 0.5;
        const matrix = Matrix.Compose(
          new Vector3(1, 0.94 + jitter * 0.13, 1),
          // Everyone faces the court, with enough spread that the row does not
          // read as a comb. The figures are modelled facing +z, so the far side
          // has to turn around.
          Quaternion.RotationYawPitchRoll(
            (side > 0 ? Math.PI : 0) + (jitter - 0.5) * 0.7,
            0,
            0
          ),
          // Push each person off their row by up to half a spacing. Rows that
          // stay perfectly parallel read as a fence however far apart they are.
          new Vector3(x, GROUND_Y, z + (seed - 0.5) * spec.spacing * 1.1)
        );
        placeAt(into, library[Math.floor(seed * library.length) % library.length], matrix);
      }
    }
  }
}

/**
 * Where each figure is asked to appear, accumulated across every placement
 * pass before any buffer is written.
 *
 * Accumulating rather than appending to a live mesh is deliberate: one figure
 * can be wanted by the touchline rows *and* by a bench, and reading the
 * existing instances back out of Babylon to extend them does not work — the
 * world-matrix array it would read is not built until the buffer has been
 * uploaded, so the first pass throws and takes the whole crowd with it.
 */
type Placement = Map<Mesh, Matrix[]>;

function placeAt(into: Placement, person: Mesh, matrix: Matrix): void {
  const list = into.get(person);
  if (list) list.push(matrix);
  else into.set(person, [matrix]);
}

/**
 * Upload every accumulated placement, once.
 *
 * Returns the meshes and the exact arrays that were uploaded, because the
 * animator has to own those arrays: it rewrites them in place and tells
 * Babylon the buffer changed, which is far cheaper than rebuilding matrices.
 */
function applyPlacement(into: Placement): { placed: Mesh[]; buffers: [Mesh, Float32Array][] } {
  const placed: Mesh[] = [];
  const buffers: [Mesh, Float32Array][] = [];
  for (const [person, matrices] of into) {
    if (matrices.length === 0) continue;
    const buffer = new Float32Array(matrices.length * 16);
    matrices.forEach((m, i) => m.copyToArray(buffer, i * 16));
    // Not a static buffer: the crowd animator rewrites it every frame.
    person.thinInstanceSetBuffer("matrix", buffer, 16, false);
    person.setEnabled(true);
    placed.push(person);
    buffers.push([person, buffer]);
  }
  return { placed, buffers };
}

/**
 * Seat people on the benches the venue models already contain.
 *
 * The three outdoor grounds share a scene template with eight benches, and
 * their positions are measured from the model rather than guessed — see the
 * README. Everyone here uses a seated pose, which is why those figures are
 * kept at all: on flat ground they look like they have fallen over, and on a
 * bench they are the only ones that work.
 */
function placeOnBenches(
  spec: NonNullable<Dressing["benches"]>,
  seated: Mesh[],
  into: Placement
): void {
  if (seated.length === 0) return;
  const noise = (a: number, b: number): number => {
    const n = Math.sin(a * 91.7 + b * 47.3) * 33417.19;
    return n - Math.floor(n);
  };
  spec.seats.forEach(([x, z], i) => {
    for (let k = 0; k < spec.perBench; k++) {
      const seed = noise(i * 5 + k, i);
      if (seed > spec.density) continue;
      const along = (k + 0.5 - spec.perBench / 2) * spec.spacing;
      placeAt(
        into,
        seated[Math.floor(seed * seated.length) % seated.length],
        Matrix.Compose(
          new Vector3(1, 1, 1),
          // Facing the court: the near-side benches have to turn around.
          Quaternion.RotationYawPitchRoll(
            (z > 0 ? Math.PI : 0) + (seed - 0.5) * 0.4,
            0,
            0
          ),
          new Vector3(x + along, GROUND_Y + spec.height, z)
        )
      );
    }
  });
}

/**
 * Fill a bowl of bleachers: concentric elliptical rows, rising as they go back.
 *
 * The indoor hall is one seating bowl and its rows are modelled as full rings,
 * so there is no per-seat geometry to read positions off — the rake is given
 * here as a start radius and a rise per row, and checked by looking. Mostly
 * seated, with a scattering standing, because a stand where everybody is doing
 * the same thing reads as wallpaper.
 */
function placeOnTiers(
  scene: Scene,
  spec: NonNullable<Dressing["tiers"]>,
  seated: Mesh[],
  standing: Mesh[],
  into: Placement,
  out: Mesh[]
): void {
  if (seated.length === 0 && standing.length === 0) return;

  // Build the stand as well as fill it.
  //
  // The first attempt tried to seat people on the hall's own bowl, whose rows
  // are modelled as bare concentric rings with no per-seat geometry — there is
  // no rake to read, and every guess at one put people through a wall or out
  // on the grass. Constructing the deck removes the guess: we know where the
  // seats are because we put them there, and the venue's own bowl becomes the
  // backdrop behind it.
  const deckMat = flat(scene, "tier-deck", spec.deck, 0.05);
  const risers: Mesh[] = [];
  for (let row = 0; row < spec.rows; row++) {
    const rx = spec.radiusX + row * spec.step;
    const rz = spec.radiusZ + row * spec.step;
    const y = GROUND_Y + spec.lift + row * spec.rise;
    const steps = 56;
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      const next = ((i + 1) / steps) * Math.PI * 2;
      const x = Math.cos(a) * rx;
      const z = Math.sin(a) * rz;
      const span = Math.hypot(Math.cos(next) * rx - x, Math.sin(next) * rz - z);
      const slab = MeshBuilder.CreateBox(
        `tier-${row}-${i}`,
        // Deep enough to stand a row on, tall enough to reach the deck below.
        { width: span * 1.06, height: spec.rise + spec.lift, depth: spec.step * 1.5 },
        scene
      );
      const mid = (a + next) / 2;
      slab.position.set(
        Math.cos(mid) * rx,
        y - (spec.rise + spec.lift) / 2 + spec.rise,
        Math.sin(mid) * rz
      );
      slab.rotation.y = Math.atan2(Math.cos(mid) * rx, -Math.sin(mid) * rz);
      risers.push(slab);
    }
  }
  const deck = risers.length > 1 ? Mesh.MergeMeshes(risers, true, true) : risers[0];
  if (deck) {
    deck.material = deckMat;
    out.push(deck);
  }

  const noise = (a: number, b: number): number => {
    const n = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
    return n - Math.floor(n);
  };

  for (let row = 0; row < spec.rows; row++) {
    const rx = spec.radiusX + row * spec.step;
    const rz = spec.radiusZ + row * spec.step;
    const y = GROUND_Y + spec.lift + row * spec.rise;
    // Keep the spacing along the row roughly constant as the ring grows.
    const circumference = Math.PI * (3 * (rx + rz) - Math.sqrt((3 * rx + rz) * (rx + 3 * rz)));
    const count = Math.max(8, Math.round(circumference / spec.spacing));
    for (let i = 0; i < count; i++) {
      const seed = noise(i * 3 + row * 29, row);
      if (seed > spec.density) continue;
      const a = (i / count) * Math.PI * 2;
      const x = Math.cos(a) * rx;
      const z = Math.sin(a) * rz;
      // Everyone faces the middle. The figures are modelled facing +z, so the
      // yaw is measured from that.
      const yaw = Math.atan2(-x, -z) + (seed - 0.5) * 0.3;
      // A tenth of the bowl is on its feet.
      const standingHere = seed > spec.density * 0.9;
      const pool = standingHere && standing.length > 0 ? standing : seated;
      if (pool.length === 0) continue;
      placeAt(
        into,
        pool[Math.floor(seed * 977) % pool.length],
        Matrix.Compose(
          new Vector3(1, 1, 1),
          Quaternion.RotationYawPitchRoll(yaw, 0, 0),
          new Vector3(x, y, z)
        )
      );
    }
  }
}

/** Corner flags, for the outdoor grounds where a stand would be too much. */
function buildFlags(scene: Scene, colors: Rgb[], L: number, W: number): Mesh[] {
  const materials = colors.map((c, i) => flat(scene, `flag-${i}`, c, 0.4));
  const groups = new Map<number, Mesh[]>();
  const corners: [number, number][] = [
    [L + 1.1, W + 1.1],
    [L + 1.1, -(W + 1.1)],
    [-(L + 1.1), W + 1.1],
    [-(L + 1.1), -(W + 1.1)],
  ];
  corners.forEach(([x, z], i) => {
    const pole = MeshBuilder.CreateCylinder(`flagpole-${i}`, { diameter: 0.07, height: 3.4 }, scene);
    pole.position.set(x, GROUND_Y + 1.7, z);
    const banner = MeshBuilder.CreateBox(`flag-${i}`, { width: 0.06, height: 1.5, depth: 0.9 }, scene);
    banner.position.set(x, GROUND_Y + 2.5, z + (z > 0 ? -0.5 : 0.5));
    const index = i % materials.length;
    const group = groups.get(index);
    if (group) group.push(pole, banner);
    else groups.set(index, [pole, banner]);
  });
  return mergeByColour(groups, materials);
}

/**
 * Build every piece of dressing this venue asks for.
 *
 * Returns the meshes so the caller can decide about shadows; they are frozen
 * here because none of them ever moves.
 */
export async function buildEnvironment(scene: Scene, venue: Venue, crowd?: Crowd): Promise<Mesh[]> {
  const { court, dressing } = venue;
  const built: Mesh[] = [];
  let crowdBuffers: [Mesh, Float32Array][] = [];
  if (dressing.ribbon) {
    built.push(...buildRibbon(scene, dressing.ribbon, court.shape, court.halfLen, court.halfWid));
  }
  if (dressing.crowd || dressing.benches || dressing.tiers) {
    // A crowd that fails to download is not worth losing the venue over.
    const library = await loadCrowdLibrary(scene).catch((e) => {
      console.warn("Crowd failed to load:", e);
      return { standing: [], seated: [] };
    });
    const placement: Placement = new Map();
    if (dressing.crowd) {
      placeCrowd(dressing.crowd, library.standing, court.halfLen, court.halfWid, placement);
    }
    if (dressing.benches) placeOnBenches(dressing.benches, library.seated, placement);
    if (dressing.tiers) {
      placeOnTiers(scene, dressing.tiers, library.seated, library.standing, placement, built);
    }
    const applied = applyPlacement(placement);
    built.push(...applied.placed);
    crowdBuffers = applied.buffers;
    // Anything left unplaced is still a mesh in the scene, drawn once at the
    // origin — through the middle of the court, in full view.
    for (const m of [...library.standing, ...library.seated]) {
      if (!placement.has(m)) m.dispose();
    }
  }
  if (dressing.flags) {
    built.push(...buildFlags(scene, dressing.flags, court.halfLen, court.halfWid));
  }
  // Hand the crowd's instance buffers to the animator before freezing: it
  // rewrites them in place every frame, and a frozen world matrix does not
  // stop that — the matrices are a separate buffer.
  if (crowd) {
    for (const [person, data] of crowdBuffers) {
      crowd.add(data, () => person.thinInstanceBufferUpdated("matrix"));
    }
  }
  for (const m of built) {
    m.isPickable = false;
    m.freezeWorldMatrix();
  }
  return built;
}
