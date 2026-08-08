// Throwaway page: bakes the crowd figures' cheer loop and instances them, so
// the baked animation can be watched before it is wired into a venue.
// Not a build entry, so it does not ship.
import { Engine } from "@babylonjs/core/Engines/engine";
import { Scene } from "@babylonjs/core/scene";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { Vector3, Color3, Color4, Matrix } from "@babylonjs/core/Maths/math";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import "@babylonjs/loaders/glTF/2.0";
import { loadRiggedFigures, animationSettingsBuffer } from "../src/crowdrig";

const canvas = document.getElementById("c") as HTMLCanvasElement;
const engine = new Engine(canvas, true);
const scene = new Scene(engine);
scene.clearColor = new Color4(0.11, 0.14, 0.2, 1);
new HemisphericLight("h", new Vector3(0, 1, 0), scene).intensity = 0.8;
const sun = new DirectionalLight("s", new Vector3(-0.4, -1, 0.35), scene);
sun.intensity = 1.1;

const camera = new ArcRotateCamera("c", -Math.PI / 2, 1.15, 14, new Vector3(0, 0.9, 0), scene);
camera.attachControl(canvas, true);

const figures = await loadRiggedFigures(scene, ["f1.glb", "f2.glb", "f3.glb", "f4.glb"]);

const report: Record<string, unknown> = { figures: figures.length };
let seed = 7;
const random = (): number => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};

figures.forEach((fig, f) => {
  fig.mesh.refreshBoundingInfo({ applySkeleton: true });
  const material = new StandardMaterial(`m${f}`, scene);
  material.specularColor = new Color3(0.05, 0.05, 0.05);
  fig.mesh.material = material;

  const count = 6;
  const matrices = new Float32Array(count * 16);
  for (let i = 0; i < count; i++) {
    fig.grounding
      .multiply(Matrix.Translation((i - (count - 1) / 2) * 1.1, 0, f * 1.4 - 2.1))
      .copyToArray(matrices, i * 16);
  }
  fig.mesh.thinInstanceSetBuffer("matrix", matrices, 16, true);
  fig.mesh.thinInstanceSetBuffer(
    "bakedVertexAnimationSettingsInstanced",
    animationSettingsBuffer(count, random),
    4,
    true
  );
  fig.mesh.setEnabled(true);

  fig.mesh.refreshBoundingInfo({ applySkeleton: true });
  const box = fig.mesh.getBoundingInfo().boundingBox;
  report[`figure${f}`] = {
    tris: fig.mesh.getTotalIndices() / 3,
    posedHeight: +(box.maximum.y - box.minimum.y).toFixed(3),
    footY: +box.minimum.y.toFixed(3),
    texture: fig.manager.texture
      ? `${fig.manager.texture.getSize().width}x${fig.manager.texture.getSize().height}`
      : "missing",
    instances: fig.mesh.thinInstanceCount,
    enabled: fig.mesh.isEnabled(),
    grounding: [+fig.grounding.m[12].toFixed(2), +fig.grounding.m[13].toFixed(2), +fig.grounding.m[14].toFixed(2)],
  };
});

scene.registerBeforeRender(() => {
  const dt = engine.getDeltaTime() / 1000;
  for (const fig of figures) fig.manager.time += dt;
});

scene.render();
report.activeMeshes = scene.getActiveMeshes().length;
// Frame whatever was actually produced, rather than where it was meant to be.
{
  let lo = new Vector3(1e9, 1e9, 1e9);
  let hi = new Vector3(-1e9, -1e9, -1e9);
  for (const fig of figures) {
    fig.mesh.thinInstanceRefreshBoundingInfo(true);
    const b = fig.mesh.getBoundingInfo().boundingBox;
    lo = Vector3.Minimize(lo, b.minimumWorld);
    hi = Vector3.Maximize(hi, b.maximumWorld);
  }
  camera.setTarget(lo.add(hi).scale(0.5));
  camera.radius = hi.subtract(lo).length() * 1.1;
  report.framed = { target: camera.getTarget().asArray().map((v) => +v.toFixed(2)), radius: +camera.radius.toFixed(1) };
}
// Where did instance 0 of each figure actually end up?
report.instanceWorld = figures.map((fig) => {
  fig.mesh.thinInstanceRefreshBoundingInfo(true);
  const b = fig.mesh.getBoundingInfo().boundingBox;
  return {
    min: b.minimumWorld.asArray().map((v) => +v.toFixed(2)),
    max: b.maximumWorld.asArray().map((v) => +v.toFixed(2)),
  };
});
// Is the baked-animation path actually compiled into the shader?
scene.render();
report.buffers = figures.map((fig) => ({
  colour: fig.mesh.isVerticesDataPresent(VertexBuffer.ColorKind),
  boneIdx: fig.mesh.isVerticesDataPresent(VertexBuffer.MatricesIndicesKind),
  boneW: fig.mesh.isVerticesDataPresent(VertexBuffer.MatricesWeightsKind),
  useVertexColors: fig.mesh.useVertexColors,
  numBoneInfluencers: fig.mesh.numBoneInfluencers,
  thinCount: fig.mesh.thinInstanceCount,
}));
report.defines = figures.map((fig) => {
  const sm = fig.mesh.subMeshes[0] as unknown as { materialDefines?: { toString(): string } };
  const d = sm?.materialDefines?.toString() ?? "";
  return {
    vat: d.includes("#define BAKED_VERTEX_ANIMATION_TEXTURE"),
    inst: d.includes("#define INSTANCES"),
    thin: d.includes("#define THIN_INSTANCES"),
    vcol: d.includes("#define VERTEXCOLOR"),
    bones: /#define NUM_BONE_INFLUENCERS (\d+)/.exec(d)?.[1] ?? "0",
    len: d.length,
  };
});
report.shader = figures.map((fig) => {
  const mat = fig.mesh.material;
  const effect = mat?.getEffect?.();
  const defines = (effect as unknown as { defines?: string })?.defines ?? "";
  return {
    material: mat?.getClassName?.(),
    vat: defines.includes("BAKED_VERTEX_ANIMATION_TEXTURE"),
    instances: defines.includes("#define INSTANCES"),
    thin: defines.includes("THIN_INSTANCES"),
    bones: /NUM_BONE_INFLUENCERS (\d+)/.exec(defines)?.[1] ?? "none",
    vcol: defines.includes("VERTEXCOLOR"),
    hasSkeleton: !!fig.mesh.skeleton,
    managerEnabled: fig.manager.isEnabled,
  };
});
(window as unknown as { __rig: unknown }).__rig = report;
engine.runRenderLoop(() => scene.render());
