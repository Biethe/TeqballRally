// Offline bake: turns each rigged crowd figure into a texture of bone
// matrices, which the game then loads as a file instead of computing at
// startup.
//
// Driven by scripts/bake-crowd.mjs; not a build entry, so it never ships.
//
// This uses Babylon's own VertexAnimationBaker deliberately. Baking the
// matrices by hand did not reproduce even the bind pose — with every clip
// removed the arms sheared into spikes — so the chain is left to the engine.
// Its one cost is that it drives scene.beginAnimation a frame at a time and
// waits for each, which is exactly why this runs here rather than on a phone.
//
// The clips animate each bone's "_matrix", the channel Babylon's own imported
// skeleton animations use. The quaternion setters do not take on this rig:
// setRotationQuaternion left bone.rotationQuaternion unchanged.
import { Engine } from "@babylonjs/core/Engines/engine";
import { Scene } from "@babylonjs/core/scene";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import { Animation } from "@babylonjs/core/Animations/animation";
import type { AnimationRange } from "@babylonjs/core/Animations/animationRange";
import { VertexAnimationBaker } from "@babylonjs/core/BakedVertexAnimation/vertexAnimationBaker";
import "@babylonjs/core/Animations/animatable";
import "@babylonjs/loaders/glTF/2.0";
import { CHEER, CROWD_FILES, CROWD_FPS, CROWD_FRAMES } from "../src/crowdclips";

const canvas = document.getElementById("c") as HTMLCanvasElement;
const engine = new Engine(canvas, true);
const scene = new Scene(engine);
new HemisphericLight("h", new Vector3(0, 1, 0), scene);
new FreeCamera("c", new Vector3(0, 1, -4), scene);
engine.runRenderLoop(() => scene.render());

/**
 * Base64 in chunks.
 *
 * `String.fromCharCode(...bytes)` spreads every byte as an argument, which
 * overflows the call stack on a buffer this size — each figure's matrices run
 * to about 166 KB.
 */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

const results: Record<string, { width: number; height: number; data: string }> = {};

for (const file of CROWD_FILES) {
  const res = await SceneLoader.ImportMeshAsync("", "/models/Crowd/", file, scene);
  const mesh = res.meshes.find((m) => m.getTotalVertices() > 0)!;
  const skeleton = res.skeletons[0];

  for (const bone of skeleton.bones) {
    const clip = CHEER.find((c) => bone.name.endsWith(`_skeleton_${c.bone}`));
    if (!clip) continue;

    const scale = new Vector3();
    const rotation = new Quaternion();
    const position = new Vector3();
    bone.getLocalMatrix().decompose(scale, rotation, position);

    const keys = [];
    for (let frame = 0; frame <= CROWD_FRAMES; frame++) {
      const t = frame / CROWD_FRAMES;
      const swing = Math.sin((t * clip.cycles + clip.phase) * Math.PI * 2);
      const value = new Matrix();
      Matrix.ComposeToRef(
        scale,
        rotation.multiply(Quaternion.RotationAxis(clip.axis, swing * clip.amplitude)),
        position,
        value
      );
      keys.push({ frame, value });
    }
    const animation = new Animation(
      `${bone.name}-cheer`,
      "_matrix",
      CROWD_FPS,
      Animation.ANIMATIONTYPE_MATRIX,
      Animation.ANIMATIONLOOPMODE_CYCLE
    );
    animation.setKeys(keys);
    bone.animations = [animation];
  }

  const range: AnimationRange = { name: "cheer", from: 0, to: CROWD_FRAMES - 1 } as AnimationRange;
  const baker = new VertexAnimationBaker(scene, mesh as never);
  const data = await baker.bakeVertexData([range]);

  const boneCount = skeleton.bones.length;
  results[file] = {
    width: (boneCount + 1) * 4,
    height: CROWD_FRAMES,
    data: toBase64(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)),
  };

  // A bake whose frames match is the failure that looks like "no animation".
  const stride = data.length / CROWD_FRAMES;
  let spread = 0;
  for (let i = 0; i < stride; i++) {
    spread = Math.max(spread, Math.abs(data[i] - data[i + stride * (CROWD_FRAMES >> 1)]));
  }
  console.log(`baked ${file}: ${boneCount} bones, spread ${spread.toFixed(4)}`);

  for (const m of res.meshes) m.dispose();
  skeleton.dispose();
}

(window as unknown as { __bake: unknown }).__bake = results;
