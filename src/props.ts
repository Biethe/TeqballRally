/**
 * Real scenery props: houses, street trees, parked cars, palms.
 *
 * `surroundings.ts` built the world out of boxes and spheres, which reads as a
 * world at a hundred metres and as a diorama at thirty. These are modelled
 * props from four low-poly packs, merged into one 450 KB file that every venue
 * shares.
 *
 * Three things make them cheap enough to stand around a phone game:
 *
 * - **One material, no textures.** The packs' colour came from a palette atlas
 *   with no detail in it — every window and wheel is geometry — so the atlas
 *   was sampled per vertex at build time and thrown away. Fifty props are one
 *   material and no texture fetches.
 * - **Thin instances.** A prop placed forty times is one draw call.
 * - **Decimated at build time.** The houses and cars came in at 3-8k triangles
 *   each, which is a foreground budget; they ship at roughly 900-1600.
 *
 * The build pipeline is in `scripts/props/`.
 */

import type { Scene } from "@babylonjs/core/scene";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Material } from "@babylonjs/core/Materials/material";
import { Color3 } from "@babylonjs/core/Maths/math.color";

/** Prop families in `Props.glb`, by the prefix their nodes are named with. */
export type PropKind = "house" | "tree" | "car" | "palm" | "bush";

/** Every prop of a kind, ready to be thin instanced. */
export type PropLibrary = Map<PropKind, Mesh[]>;

const KINDS: PropKind[] = ["house", "tree", "car", "palm", "bush"];

/**
 * Metres tall, per kind, applied uniformly to every prop in it.
 *
 * The packs disagree about scale — the planting runs from 0.1 to 60 units —
 * and a prop that is half a metre out is the single most diorama-like thing in
 * a backdrop. Normalising on height keeps each family's own proportions while
 * putting all of them in the same world.
 *
 * `house` is 20 m because these are not houses. Each node in the building pack
 * is a whole street — measured at 99 x 200 m and 94 x 33 m — so the family is
 * city blocks, and a block normalised to a cottage's 9.5 m becomes a
 * two-hundred-metre-long slab lying behind the fence.
 */
const HEIGHT: Record<PropKind, number> = {
  house: 20,
  tree: 6.4,
  car: 1.55,
  palm: 7.2,
  bush: 1.5,
};

/**
 * Where each family of props comes from.
 *
 * Three packs rather than one, because the houses and the planting were
 * replaced wholesale and re-exporting them into a single file would mean
 * renaming every node to a convention none of the packs use. Each source says
 * which kinds it can provide, so a venue that wants no planting never
 * downloads any, and how to read a kind out of that pack's own naming.
 */
interface PropSource {
  dir: string;
  file: string;
  provides: PropKind[];
  kindOf: (name: string) => PropKind | null;
  /**
   * Whether this pack's own materials are worth keeping.
   *
   * The original pack carries no textures at all — its colour was sampled into
   * vertex colours at build time — so one shared white material is exactly
   * right for it and costs nothing. The buildings and the planting are
   * textured, and handing them that same material paints every building white
   * and every leaf grey, which is precisely what it did.
   */
  keepMaterials: boolean;
}

const SOURCES: PropSource[] = [
  {
    dir: "/models/Buildings/",
    file: "Buildings.glb",
    provides: ["house"],
    // Every building in the pack is `bina`, `bina.001`, `bina.002`… `Plane` is
    // the slab they were exported standing on, and is not a prop.
    kindOf: (n) => (/^bina(\.\d+)?$/i.test(n) ? "house" : null),
    keepMaterials: true,
  },
  {
    dir: "/models/Plants/",
    file: "Plants.glb",
    provides: ["tree", "bush"],
    // Tree-01-1 … Tree-03-4, plus Hedge-01 and Bush-01…05. The kit's ground
    // cover — clover, grass, flowers — is deliberately left out: it is metres
    // across at this scale and never seen from the court.
    kindOf: (n) =>
      /^tree-/i.test(n) ? "tree" : /^(bush|hedge)-/i.test(n) ? "bush" : null,
    keepMaterials: true,
  },
  {
    dir: "/models/Props/",
    file: "Props.glb",
    provides: ["car", "palm"],
    // The original pack, still the only source of parked cars and palms.
    kindOf: (n) => {
      const kind = KINDS.find((k) => new RegExp(`^${k}_\\d+$`).test(n));
      return kind === "car" || kind === "palm" ? kind : null;
    },
    keepMaterials: false,
  },
];

/** Foliage is drawn from both sides; a wall is not. */
const DOUBLE_SIDED: ReadonlySet<PropKind> = new Set<PropKind>(["tree", "bush", "palm"]);

/**
 * Load the prop library, keeping only the kinds asked for.
 *
 * Everything lives in one GLB, so the unwanted kinds are loaded and then
 * disposed rather than skipped. That is deliberate: one request that every
 * venue shares beats five that each venue picks from, at this file size.
 */
export async function loadProps(scene: Scene, kinds: PropKind[]): Promise<PropLibrary> {
  const wanted = SOURCES.filter((src) => src.provides.some((k) => kinds.includes(k)));
  const loaded = await Promise.all(
    wanted.map((src) =>
      SceneLoader.ImportMeshAsync("", src.dir, src.file, scene).then(
        (res) => ({ res, src }),
        (error: unknown) => {
          // A missing pack costs its own props and nothing else: a venue with
          // no trees beats a venue that will not open.
          console.warn(`Prop pack ${src.file} failed:`, error);
          return null;
        }
      )
    )
  );

  const shared = new StandardMaterial("prop", scene);
  shared.diffuseColor = new Color3(1, 1, 1);
  shared.specularColor = new Color3(0.02, 0.02, 0.02);
  // A little self-illumination so props facing away from the sun read as
  // colour rather than silhouette. They are scenery, not something to inspect.
  // Several models in the house pack have near-black roofs in their palette,
  // and unlit they read as a hole in the building rather than a roof. This is
  // set high enough to keep them reading as surfaces.
  shared.emissiveColor = new Color3(0.14, 0.14, 0.14);
  // Backfaces are culled, which the build step earns: it rewinds any triangle
  // whose winding disagrees with the normal it carries, so what is left is a
  // consistently wound set of models rather than the double-sided-by-default
  // geometry the packs ship.

  /**
   * The same material, drawn from both sides, for planting.
   *
   * The kit is authored as double-sided cards — its own filename says so — and
   * a leaf card culled from behind is simply gone. Half of every tree
   * disappears depending on which way it happens to face, which reads as a
   * flat sticker rather than a tree.
   */
  const foliage = new StandardMaterial("prop-foliage", scene);
  foliage.diffuseColor = shared.diffuseColor;
  foliage.specularColor = shared.specularColor;
  foliage.emissiveColor = shared.emissiveColor;
  foliage.backFaceCulling = false;

  /**
   * The prop a mesh belongs to, by walking up to the node the exporter named.
   *
   * Not simply `m.parent`: the compression pass nests a generated `node0`
   * between the named node and its mesh, so the parent is anonymous and the
   * prop's name lives one level further up. Same shape as the crowd library.
   */
  const propOf = (m: Mesh, src: PropSource): { kind: PropKind; name: string } | null => {
    // The mesh itself when the exporter's node carries it directly, and
    // otherwise a walk up the chain: the compression pass inserts a generated
    // node between a named node and its mesh whenever it needs one to hold a
    // dequantization transform, so the name is one or two levels up depending
    // on how the file was packed.
    for (let node: { name: string; parent: unknown } | null = m; node; node = node.parent as never) {
      const kind = src.kindOf(node.name);
      // The suffix has to come off before the name is used as a prop's
      // identity. A glTF mesh with several materials arrives as one Babylon
      // mesh per primitive — `Tree-01-1_primitive0`, `_primitive1`, `_2` — and
      // keeping those apart made one tree into three props, after which the
      // scatter picked a spread of them and disposed the rest. It kept the
      // trunks and threw the branches away, which is why every tree was a
      // bare stick.
      if (kind) return { kind, name: node.name.replace(/_primitive\d+$/, "") };
    }
    return null;
  };

  /**
   * A prop's meshes, gathered under the name the exporter gave it.
   *
   * The original pack is one mesh per prop; these are not. A tree in the
   * planting kit is a trunk *and* its foliage, as separate meshes under one
   * node — and `scatterProps` picks a spread of the props it is given and
   * disposes the rest, so handing it a flat list of meshes had it keeping
   * trunks and throwing the leaves away. Every tree came back a bare stick.
   */
  const byProp = new Map<string, { kind: PropKind; parts: Mesh[]; keepMaterials: boolean }>();
  for (const entry of loaded) {
    if (!entry) continue;
    const { res, src } = entry;
    for (const m of res.meshes) {
      if (!(m instanceof Mesh) || m.getTotalVertices() === 0) continue;
      const prop = propOf(m, src);
      if (!prop || !kinds.includes(prop.kind)) {
        m.dispose();
        continue;
      }
      const { kind } = prop;
      // Carry the prop's name onto the mesh before its named parent goes: it is
      // the only handle left once the hierarchy is flattened.
      m.name = prop.name;
      // Detach from the loader's root before instancing. The glTF loader parents
      // everything under a `__root__` that mirrors one axis to convert
      // handedness, and a thin instance matrix is applied *inside* that — so a
      // prop left attached is placed in a mirrored world. Baking folds the
      // mirror into the vertices, and `bakeTransformIntoVertices` reverses the
      // winding to match.
      m.setParent(null);
      m.bakeCurrentTransformIntoVertices();
      // Baking also rewrites the vertex buffer while leaving the bounding box
      // the loader built from the file's own accessor bounds, so it has to be
      // asked for again — otherwise the height read below is the height before
      // the bake, and every prop is scaled by the wrong number.
      m.refreshBoundingInfo();

      const group = byProp.get(prop.name);
      if (group) group.parts.push(m);
      else byProp.set(prop.name, { kind, parts: [m], keepMaterials: src.keepMaterials });
    }
    // Dispose the transform nodes the props hung from, and the loader root.
    for (const node of res.transformNodes) {
      if (node.getChildren().length === 0) node.dispose();
    }
  }

  const library: PropLibrary = new Map();
  for (const [name, { kind, parts, keepMaterials }] of byProp) {
    // One mesh per prop again, which is what the scatter and the instancing
    // both assume. Multi-material merging keeps a trunk's bark and its leaves
    // as separate submeshes of one drawable.
    const m =
      parts.length === 1
        ? parts[0]
        : Mesh.MergeMeshes(parts, true, true, undefined, false, true);
    if (!m) continue;
    m.name = name;
    // Measured after merging, so a tree is scaled by its own full height and
    // not by whichever of its parts happened to be read first.
    m.refreshBoundingInfo();
    const box = m.getBoundingInfo().boundingBox;
    const scale = HEIGHT[kind] / Math.max(0.001, box.maximum.y - box.minimum.y);
    m.scaling.setAll(scale);
    m.bakeCurrentTransformIntoVertices();
    m.refreshBoundingInfo();

    if (keepMaterials) {
      // The pack's own textured material, kept as it is — apart from how its
      // leaves are cut out.
      //
      // The planting kit ships every leaf card as alphaMode BLEND, and blended
      // geometry writes no depth. Alpha *test* is what a leaf card wants: the
      // texture is a cut-out, not a window, and nothing has to be sorted.
      const multi = m.material as { subMaterials?: (typeof m.material)[] } | null;
      for (const mat of multi?.subMaterials ?? [m.material]) {
        if (!mat || !DOUBLE_SIDED.has(kind)) continue;
        mat.backFaceCulling = false;
        mat.transparencyMode = Material.MATERIAL_ALPHATEST;
        (mat as { alphaCutOff?: number }).alphaCutOff = 0.4;
      }
    } else {
      m.material = shared;
    }
    // Vertex colours are a mesh flag, not a material one, and default to on —
    // set it explicitly so the single shared material cannot be misread as the
    // thing that would paint every prop the same colour.
    m.useVertexColors = true;
    m.isPickable = false;
    m.receiveShadows = false;

    const group = library.get(kind);
    if (group) group.push(m);
    else library.set(kind, [m]);
  }

  // A stable order, so a scatter seeded by index puts the same prop in the
  // same place on both peers of an online match and between runs.
  //
  // `house_10`, `bina.004` and `Tree-01-2` are three conventions; every digit
  // in the name, read as one number, orders all of them stably. The value is
  // meaningless on its own — only that it is the same on every run and every
  // peer, which is what a seeded scatter needs.
  const ordinal = (m: Mesh): number => Number(m.name.replace(/\D+/g, "")) || 0;
  for (const group of library.values()) group.sort((a, b) => ordinal(a) - ordinal(b));
  return library;
}
