import {
  loadRiggedFigures,
  animationSettingsBuffer,
  driveCrowdClocks,
  type RiggedFigure,
} from "./crowdrig";
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
import { COURT, GROUND_Y } from "./config";
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
  /** Baked figures by mesh, so placement can upload their animation timings. */
  rigged: Map<Mesh, RiggedFigure>;
}

/**
 * Skinned, animated spectators.
 *
 * Returns an empty library rather than throwing: the caller already treats
 * that as "venue without a crowd", which beats a venue that will not open.
 */
/**
 * Whether spectators are placed at all.
 *
 * Off for this release, by decision: the crowd is going into a later version.
 * Everything it needs is still here — the figures, their baked animation, the
 * bake pipeline and the placement below — so turning it back on is this one
 * flag, not a rebuild.
 */
const SHOW_CROWD = false;

async function loadRiggedCrowdLibrary(scene: Scene): Promise<CrowdLibrary> {
  if (!SHOW_CROWD) return { standing: [], seated: [], rigged: new Map() };
  const figures = await loadRiggedFigures(scene);
  driveCrowdClocks(scene, figures);
  const rigged = new Map<Mesh, RiggedFigure>();
  for (const f of figures) rigged.set(f.mesh, f);
  return {
    standing: figures.filter((f) => f.spec.posture === "standing").map((f) => f.mesh),
    seated: figures.filter((f) => f.spec.posture === "seated").map((f) => f.mesh),
    rigged,
  };
}


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
/**
 * Whether somebody standing here would be in the camera's lap.
 *
 * The sidelines and the benches both run the whole length of the court, and
 * the play camera sits behind the near baseline looking down it — so the last
 * few seats at that end are between the lens and the game, and a spectator two
 * metres from a wide portrait lens is a wall of hair at the edge of the frame.
 * Nobody is placed nearer the camera than a player can stand.
 */
function inCameraNearField(x: number): boolean {
  return x < -COURT.maxX + 2.5;
}

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

  // One sideline, not both, and deliberately the one opposite the side camera.
  //
  // From the sideline in portrait the geometry leaves no choice: framing an
  // 18 m court across the narrow dimension of the screen puts the lens further
  // out than the crowd ring, so a near row is always between the camera and
  // the play — a wall of heads across the bottom of the frame. Standing people
  // go on +z; the side camera looks from -z; the benches and the far row still
  // read as a crowd from behind the baseline.
  for (const side of [1]) {
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
        if (inCameraNearField(x)) continue;
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
function applyPlacement(
  into: Placement,
  rigged: Map<Mesh, RiggedFigure> = new Map()
): Mesh[] {
  const placed: Mesh[] = [];
  // Deterministic, so both peers of an online match see the same crowd.
  let tintSeed = 0x9e3779b9;
  const tintRandom = (): number => {
    tintSeed = (tintSeed * 1103515245 + 12345) & 0x7fffffff;
    return tintSeed / 0x7fffffff;
  };
  for (const [person, matrices] of into) {
    if (matrices.length === 0) continue;
    const buffer = new Float32Array(matrices.length * 16);
    // Each figure carries the seat it was exported at; grounding cancels that
    // before the placement puts it on its mark.
    const grounding = rigged.get(person)?.grounding;
    matrices.forEach((m, i) =>
      (grounding ? grounding.multiply(m) : m).copyToArray(buffer, i * 16)
    );
    // Not a static buffer: the crowd animator rewrites it every frame.
    person.thinInstanceSetBuffer("matrix", buffer, 16, false);
    let sharedTint: Float32Array | null = null;
    let sharedSettings: Float32Array | null = null;
    if (rigged.has(person)) {
      // Four figure models means four colour schemes across seventy-odd
      // spectators, which reads as a grey uniform. A per-instance tint costs
      // nothing — it rides the same instanced draw — and breaks that up. The
      // range is deliberately narrow: it multiplies the whole figure, skin
      // included, so a strong tint would turn faces green.
      const tint = new Float32Array(matrices.length * 4);
      for (let i = 0; i < matrices.length; i++) {
        tint[i * 4] = 0.78 + tintRandom() * 0.42;
        tint[i * 4 + 1] = 0.78 + tintRandom() * 0.42;
        tint[i * 4 + 2] = 0.78 + tintRandom() * 0.42;
        tint[i * 4 + 3] = 1;
      }
      person.thinInstanceSetBuffer("instanceColor", tint, 4, true);
      sharedTint = tint;
    }
    if (rigged.has(person)) {
      // Deterministic, so both peers of an online match and successive runs
      // get an identical crowd.
      let seed = matrices.length * 2654435761;
      const random = (): number => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
      };
      sharedSettings = animationSettingsBuffer(matrices.length, random);
      person.thinInstanceSetBuffer(
        "bakedVertexAnimationSettingsInstanced",
        sharedSettings,
        4,
        true
      );
    }
    person.setEnabled(true);
    placed.push(person);

    // The rest of the figure — hair, and whatever else the export split off by
    // material — takes exactly the same instance buffers. One person is one
    // set of matrices however many meshes they are made of, and the buffers
    // are shared by reference rather than copied because the animator rewrites
    // the matrix array in place every frame.
    const figure = rigged.get(person);
    for (const part of figure?.parts ?? []) {
      part.thinInstanceSetBuffer("matrix", buffer, 16, false);
      if (sharedTint) part.thinInstanceSetBuffer("instanceColor", sharedTint, 4, true);
      if (sharedSettings) {
        part.thinInstanceSetBuffer("bakedVertexAnimationSettingsInstanced", sharedSettings, 4, true);
      }
      part.setEnabled(true);
      placed.push(part);
    }
  }
  return placed;
}

/**
 * Seat people on the benches the venue models already contain.
 *
 * The three outdoor grounds share a scene template with eight benches, and
 * their positions are measured from the model rather than guessed — see
 * docs/DESIGN.md. Everyone here uses a seated pose, which is why those figures
 * are kept at all: on flat ground they look like they have fallen over, and on a
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
    if (inCameraNearField(x)) return;
    // The benches run down both touchlines; only the far one is used, for the
    // same reason the standing rows are — the side camera looks across the
    // near one, and a bench two metres from the lens is a row of backs.
    if (z < 0) return;
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
export async function buildEnvironment(scene: Scene, venue: Venue): Promise<Mesh[]> {
  const { court, dressing } = venue;
  const built: Mesh[] = [];
  if (dressing.ribbon) {
    built.push(...buildRibbon(scene, dressing.ribbon, court.shape, court.halfLen, court.halfWid));
  }
  if (dressing.crowd || dressing.benches || dressing.tiers) {
    // A crowd that fails to download is not worth losing the venue over.
    const library = await loadRiggedCrowdLibrary(scene).catch((e) => {
      console.warn("Crowd failed to load:", e);
      return { standing: [], seated: [], rigged: new Map() };
    });
    const placement: Placement = new Map();
    if (dressing.crowd) {
      placeCrowd(dressing.crowd, library.standing, court.halfLen, court.halfWid, placement);
    }
    if (dressing.benches) placeOnBenches(dressing.benches, library.seated, placement);
    if (dressing.tiers) {
      placeOnTiers(scene, dressing.tiers, library.seated, library.standing, placement, built);
    }
    const placed = applyPlacement(placement, library.rigged);
    // Tagged so the whole crowd can be hidden at once. Practice plays to an
    // empty hall: a coached lesson happening in front of a full stand is a
    // strange thing to be shown, and the figures are also the most expensive
    // part of the venue on the phones most likely to be running the tutorial.
    for (const m of placed) {
      m.metadata = { ...((m.metadata ?? {}) as Record<string, unknown>), crowd: true };
    }
    built.push(...placed);
    // Anything left unplaced is still a mesh in the scene, drawn once at the
    // origin — through the middle of the court, in full view.
    for (const m of [...library.standing, ...library.seated]) {
      if (!placement.has(m)) m.dispose();
    }
  }
  if (dressing.flags) {
    built.push(...buildFlags(scene, dressing.flags, court.halfLen, court.halfWid));
  }
  for (const m of built) {
    m.isPickable = false;
    m.freezeWorldMatrix();
  }
  return built;
}
