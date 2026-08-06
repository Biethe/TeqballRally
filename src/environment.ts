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
import { GROUND_Y } from "./config";
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
 * One spectator: a body and a head, merged so the pair still costs a single
 * draw call however many are standing there.
 *
 * A plain box at this distance reads as a coloured domino rather than a
 * person, which is what the first version of the crowd looked like. The head
 * is what makes the silhouette legible, and it is four segments because
 * nothing beyond that survives being 20 metres away and 30 pixels tall.
 *
 * Sized against the players, not against life. `CHARACTER_SCALE` puts a
 * character at about 1.45 m in a world that is otherwise 1:1 metres, so a
 * real-world 1.75 m spectator would stand a head taller than everyone on
 * court.
 */
function personMesh(scene: Scene, name: string): Mesh {
  const body = MeshBuilder.CreateBox(`${name}-body`, { width: 0.3, height: 0.78, depth: 0.22 }, scene);
  body.position.y = 0.39;
  const head = MeshBuilder.CreateSphere(`${name}-head`, { diameter: 0.19, segments: 4 }, scene);
  head.position.y = 0.87;
  const person = Mesh.MergeMeshes([body, head], true, true);
  // MergeMeshes only returns null for inputs this never produces.
  return person ?? body;
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
 * Everyone is a thin instance of one mesh per shirt colour, so the whole
 * crowd is a handful of draw calls whatever its size. The jitter is
 * deterministic — a hash of the seat's position rather than Math.random — so
 * the crowd is identical on both peers of an online match and identical
 * between runs when comparing screenshots.
 */
function buildCrowd(
  scene: Scene,
  spec: NonNullable<Dressing["crowd"]>,
  L: number,
  W: number
): Mesh[] {
  const out: Mesh[] = [];
  const mats = spec.colors.map((c, i) => flat(scene, `crowd-${i}`, c, 0.18));
  const perColour: Matrix[][] = spec.colors.map(() => []);

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
          new Vector3(1, 0.9 + jitter * 0.22, 1),
          // Everyone faces the court, with enough spread that the row does not
          // read as a comb.
          Quaternion.RotationYawPitchRoll((jitter - 0.5) * 0.7, 0, 0),
          new Vector3(x, GROUND_Y, z + (seed - 0.5) * spec.spacing * 0.4)
        );
        perColour[Math.floor(seed * mats.length) % mats.length].push(matrix);
      }
    }
  }

  mats.forEach((material, i) => {
    const matrices = perColour[i];
    if (matrices.length === 0) return;
    const person = personMesh(scene, `crowd-source-${i}`);
    person.material = material;
    const buffer = new Float32Array(matrices.length * 16);
    matrices.forEach((m, k) => m.copyToArray(buffer, k * 16));
    person.thinInstanceSetBuffer("matrix", buffer, 16, true);
    out.push(person);
  });
  return out;
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
export function buildEnvironment(scene: Scene, venue: Venue): Mesh[] {
  const { court, dressing } = venue;
  const built: Mesh[] = [];
  if (dressing.ribbon) {
    built.push(...buildRibbon(scene, dressing.ribbon, court.shape, court.halfLen, court.halfWid));
  }
  if (dressing.crowd) {
    built.push(...buildCrowd(scene, dressing.crowd, court.halfLen, court.halfWid));
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
