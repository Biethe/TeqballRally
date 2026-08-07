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
import { Color3 } from "@babylonjs/core/Maths/math.color";

/** Prop families in `Props.glb`, by the prefix their nodes are named with. */
export type PropKind = "house" | "tree" | "car" | "palm" | "bush";

/** Every prop of a kind, ready to be thin instanced. */
export type PropLibrary = Map<PropKind, Mesh[]>;

const KINDS: PropKind[] = ["house", "tree", "car", "palm", "bush"];

/**
 * Metres tall, per kind, applied uniformly to every prop in it.
 *
 * The packs disagree about scale — the houses are authored around 9 m, the
 * tropical props at anything from 0.1 to 60 units — and a prop that is half a
 * metre out is the single most diorama-like thing in a backdrop. Normalising
 * on height keeps each family's own proportions while putting all of them in
 * the same world.
 */
const HEIGHT: Record<PropKind, number> = {
  house: 7.6,
  tree: 6.4,
  car: 1.55,
  palm: 7.2,
  bush: 1.5,
};

/**
 * Load the prop library, keeping only the kinds asked for.
 *
 * Everything lives in one GLB, so the unwanted kinds are loaded and then
 * disposed rather than skipped. That is deliberate: one request that every
 * venue shares beats five that each venue picks from, at this file size.
 */
export async function loadProps(scene: Scene, kinds: PropKind[]): Promise<PropLibrary> {
  const res = await SceneLoader.ImportMeshAsync("", "/models/Props/", "Props.glb", scene);

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
   * The prop a mesh belongs to, by walking up to the node the exporter named.
   *
   * Not simply `m.parent`: the compression pass nests a generated `node0`
   * between the named node and its mesh, so the parent is anonymous and the
   * prop's name lives one level further up. Same shape as the crowd library.
   */
  const propOf = (m: Mesh): { kind: PropKind; name: string } | null => {
    // The mesh itself when the exporter's node carries it directly, and
    // otherwise a walk up the chain: the compression pass inserts a generated
    // node between a named node and its mesh whenever it needs one to hold a
    // dequantization transform, so the name is one or two levels up depending
    // on how the file was packed.
    for (let node: { name: string; parent: unknown } | null = m; node; node = node.parent as never) {
      const kind = KINDS.find((k) => new RegExp(`^${k}_\\d+$`).test(node.name));
      if (kind) return { kind, name: node.name };
    }
    return null;
  };

  const library: PropLibrary = new Map();
  for (const m of res.meshes) {
    if (!(m instanceof Mesh) || m.getTotalVertices() === 0) continue;
    const prop = propOf(m);
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

    const box = m.getBoundingInfo().boundingBox;
    const scale = HEIGHT[kind] / Math.max(0.001, box.maximum.y - box.minimum.y);
    m.scaling.setAll(scale);
    m.bakeCurrentTransformIntoVertices();
    m.refreshBoundingInfo();

    m.material = shared;
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

  // Dispose the transform nodes the props hung from, and the loader root.
  for (const node of res.transformNodes) {
    if (node.getChildren().length === 0) node.dispose();
  }

  // A stable order, so a scatter seeded by index puts the same prop in the
  // same place on both peers of an online match and between runs. Sorted on
  // the trailing number rather than the string, so `house_2` precedes
  // `house_10`.
  const ordinal = (m: Mesh): number => Number(m.name.split("_")[1] ?? 0);
  for (const group of library.values()) group.sort((a, b) => ordinal(a) - ordinal(b));
  return library;
}
