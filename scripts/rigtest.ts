// Throwaway page: works out this rig's bone axis convention by measurement.
//
// Bone local axes differ per rig and guessing them wastes iterations, so this
// rotates each bone of interest about all three local axes in both directions
// and reports which one moves the hand where it is wanted. Neither this nor
// rigtest.html is a build entry, so neither ships.
import { Engine } from "@babylonjs/core/Engines/engine";
import { Scene } from "@babylonjs/core/scene";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { Vector3, Quaternion } from "@babylonjs/core/Maths/math";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import "@babylonjs/loaders/glTF/2.0";

const canvas = document.getElementById("c") as HTMLCanvasElement;
const engine = new Engine(canvas, true);
const scene = new Scene(engine);
new HemisphericLight("h", new Vector3(0, 1, 0), scene);
new ArcRotateCamera("c", -Math.PI / 2, 1.2, 4, Vector3.Zero(), scene);

const file = new URLSearchParams(location.search).get("f") ?? "f1";
const res = await SceneLoader.ImportMeshAsync("", "/models/Crowd/", `${file}.glb`, scene);
const skeleton = res.skeletons[0];
const bone = (suffix: string) => skeleton.bones.find((b) => b.name.endsWith(suffix));

const AXES: [string, Vector3][] = [
  ["x+", new Vector3(1, 0, 0)], ["x-", new Vector3(-1, 0, 0)],
  ["y+", new Vector3(0, 1, 0)], ["y-", new Vector3(0, -1, 0)],
  ["z+", new Vector3(0, 0, 1)], ["z-", new Vector3(0, 0, -1)],
];

/** World position of a bone, with the skeleton's current pose applied. */
function tip(name: string): Vector3 {
  skeleton.computeAbsoluteMatrices(true);
  const b = bone(name);
  return b ? b.getAbsoluteMatrix().getTranslation() : Vector3.Zero();
}

const out: Record<string, unknown> = { file, bones: skeleton.bones.length,
  names: skeleton.bones.map((b) => b.name.replace(/^.*_skeleton_/, "")) };

for (const [label, target] of [
  ["LeftArm", "_skeleton_LeftHand"],
  ["RightArm", "_skeleton_RightHand"],
  ["Spine1", "_skeleton_Head"],
] as const) {
  const b = bone(`_skeleton_${label}`);
  if (!b) {
    out[label] = "missing";
    continue;
  }
  const rest = b.rotationQuaternion.clone();
  const before = tip(target);
  const scores: Record<string, string> = {};
  for (const [name, axis] of AXES) {
    b.setRotationQuaternion(rest.multiply(Quaternion.RotationAxis(axis, 1.2)), 0);
    const after = tip(target);
    scores[name] = `dy ${(after.y - before.y).toFixed(3)} dz ${(after.z - before.z).toFixed(3)}`;
    b.setRotationQuaternion(rest.clone(), 0);
  }
  out[label] = scores;
}

// Rest geometry, so the animation can be written in real proportions.
skeleton.computeAbsoluteMatrices(true);
out.rest = {
  hips: tip("_skeleton_Hips").asArray().map((v) => +v.toFixed(3)),
  head: tip("_skeleton_Head").asArray().map((v) => +v.toFixed(3)),
  leftHand: tip("_skeleton_LeftHand").asArray().map((v) => +v.toFixed(3)),
  leftFoot: tip("_skeleton_LeftFoot").asArray().map((v) => +v.toFixed(3)),
};

(window as unknown as { __rig: unknown }).__rig = out;
engine.runRenderLoop(() => scene.render());
