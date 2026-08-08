// Throwaway page: loads one extracted crowd figure and poses its arm bones,
// to prove the skin binds and deforms before any animation work is built on
// it. Neither this nor rigtest.html ships in a build.
import { Engine } from "@babylonjs/core/Engines/engine";
import { Scene } from "@babylonjs/core/scene";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { Vector3, Color3, Color4, Quaternion } from "@babylonjs/core/Maths/math";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import type { Skeleton } from "@babylonjs/core/Bones/skeleton";
import "@babylonjs/loaders/glTF/2.0";

const canvas = document.getElementById("c") as HTMLCanvasElement;
const engine = new Engine(canvas, true);
const scene = new Scene(engine);
scene.clearColor = new Color4(0.1, 0.13, 0.19, 1);
new HemisphericLight("h", new Vector3(0, 1, 0), scene).intensity = 0.75;
const sun = new DirectionalLight("s", new Vector3(-0.4, -1, 0.4), scene);
sun.intensity = 1.2;
sun.diffuse = new Color3(1, 0.97, 0.92);

const camera = new ArcRotateCamera("c", -Math.PI / 2, 1.25, 3.4, new Vector3(0, 0.95, 0), scene);
camera.attachControl(canvas, true);

const res = await SceneLoader.ImportMeshAsync("", "/models/Crowd/", "_rigtest.glb", scene);
const skeleton: Skeleton | undefined = res.skeletons[0];

const report: Record<string, unknown> = {
  meshes: res.meshes.filter((m) => m.getTotalVertices() > 0).length,
  skeletons: res.skeletons.length,
  bones: skeleton?.bones.length ?? 0,
};

if (skeleton) {
  const named = (want: string) =>
    skeleton.bones.find((b) => b.name.endsWith(want));
  report.sampleBones = skeleton.bones.slice(0, 4).map((b) => b.name);

  // Raise both arms: the pose that proves skinning, since a rigid mesh would
  // simply not change shape. The rotation is composed onto the bone's rest
  // rotation in local space — replacing it outright would discard the rest
  // pose and collapse the figure.
  const rest = new Map<string, Quaternion>();
  for (const bone of skeleton.bones) {
    rest.set(bone.name, bone.rotationQuaternion.clone());
  }
  const pose = (suffix: string, axis: Vector3, angle: number): void => {
    const bone = named(suffix);
    if (!bone) {
      report[`missing${suffix}`] = true;
      return;
    }
    const base = rest.get(bone.name)!;
    bone.setRotationQuaternion(base.multiply(Quaternion.RotationAxis(axis, angle)), 0);
  };
  for (const [suffix, angle] of [
    ["_skeleton_LeftArm", 1.9],
    ["_skeleton_RightArm", 1.9],
    ["_skeleton_LeftForeArm", 0.7],
    ["_skeleton_RightForeArm", 0.7],
  ] as const) {
    pose(suffix, Vector3.Right(), angle);
  }
  skeleton.computeAbsoluteMatrices(true);
  scene.render();
}

// The figure still carries the seat offset it had in the tribune, so frame the
// camera on where it actually is rather than on the origin.
{
  const m = res.meshes.find((x) => x.getTotalVertices() > 0);
  if (m) {
    m.refreshBoundingInfo({ applySkeleton: true });
    const b = m.getBoundingInfo().boundingBox;
    const centre = b.minimumWorld.add(b.maximumWorld).scale(0.5);
    camera.setTarget(centre);
    camera.radius = b.maximumWorld.subtract(b.minimumWorld).length() * 1.35;
  }
}

const skinned = res.meshes.find((m) => m.getTotalVertices() > 0);
report.boundsAfterPose = skinned
  ? (() => {
      const b = skinned.getBoundingInfo().boundingBox;
      return {
        min: [+b.minimum.x.toFixed(2), +b.minimum.y.toFixed(2), +b.minimum.z.toFixed(2)],
        max: [+b.maximum.x.toFixed(2), +b.maximum.y.toFixed(2), +b.maximum.z.toFixed(2)],
      };
    })()
  : null;

(window as unknown as { __rig: unknown }).__rig = report;
engine.runRenderLoop(() => scene.render());
