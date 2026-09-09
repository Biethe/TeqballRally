import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { execSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";

// Matrix & Quaternion FK helpers to compute lowest foot position in an animation
function multMat(a, b) {
  const r = new Float32Array(16);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      r[j * 4 + i] = a[i] * b[j * 4] + a[4 + i] * b[j * 4 + 1] + a[8 + i] * b[j * 4 + 2] + a[12 + i] * b[j * 4 + 3];
    }
  }
  return r;
}

function qToMat(q, t) {
  const [x, y, z, w] = q;
  const m = new Float32Array(16);
  m[0] = 1 - 2 * y * y - 2 * z * z;
  m[1] = 2 * x * y + 2 * z * w;
  m[2] = 2 * x * z - 2 * y * w;
  m[3] = 0;

  m[4] = 2 * x * y - 2 * z * w;
  m[5] = 1 - 2 * x * x - 2 * z * z;
  m[6] = 2 * y * z + 2 * x * w;
  m[7] = 0;

  m[8] = 2 * x * z + 2 * y * w;
  m[9] = 2 * y * z - 2 * x * w;
  m[10] = 1 - 2 * x * x - 2 * y * y;
  m[11] = 0;

  m[12] = t ? t[0] : 0;
  m[13] = t ? t[1] : 0;
  m[14] = t ? t[2] : 0;
  m[15] = 1;
  return m;
}

function computeMinFootY(doc, animName, yOffset = 0) {
  const root = doc.getRoot();
  const anim = root.listAnimations().find((a) => a.getName().trim() === animName);
  if (!anim) return null;

  const nodeMap = new Map();
  root.listNodes().forEach((n) => nodeMap.set(n.getName().trim(), n));

  const transMap = new Map();
  const rotMap = new Map();

  for (const ch of anim.listChannels()) {
    const tgt = ch.getTargetNode()?.getName().trim();
    if (!tgt) continue;
    const sampler = ch.getSampler();
    const outArr = sampler.getOutput()?.getArray();
    if (!outArr) continue;

    if (ch.getTargetPath() === "translation") {
      const copy = new Float32Array(outArr);
      if (tgt === "Hips" && yOffset !== 0) {
        for (let i = 0; i < copy.length / 3; i++) copy[i * 3 + 1] += yOffset;
      }
      transMap.set(tgt, copy);
    }
    if (ch.getTargetPath() === "rotation") {
      rotMap.set(tgt, outArr);
    }
  }

  function getNodeT(name, frame) {
    if (transMap.has(name)) {
      const arr = transMap.get(name);
      const idx = Math.min(frame, arr.length / 3 - 1) * 3;
      return [arr[idx], arr[idx + 1], arr[idx + 2]];
    }
    return nodeMap.get(name)?.getTranslation() || [0, 0, 0];
  }

  function getNodeR(name, frame) {
    if (rotMap.has(name)) {
      const arr = rotMap.get(name);
      const idx = Math.min(frame, arr.length / 4 - 1) * 4;
      return [arr[idx], arr[idx + 1], arr[idx + 2], arr[idx + 3]];
    }
    return nodeMap.get(name)?.getRotation() || [0, 0, 0, 1];
  }

  const hipsData = transMap.get("Hips") || rotMap.get("Hips");
  const frameCount = hipsData ? hipsData.length / (transMap.has("Hips") ? 3 : 4) : 1;
  let minFootY = Infinity;

  for (let frame = 0; frame < frameCount; frame++) {
    const mHips = qToMat(getNodeR("Hips", frame), getNodeT("Hips", frame));

    const mLU = multMat(mHips, qToMat(getNodeR("LeftUpLeg", frame), getNodeT("LeftUpLeg", frame)));
    const mLL = multMat(mLU, qToMat(getNodeR("LeftLeg", frame), getNodeT("LeftLeg", frame)));
    const mLF = multMat(mLL, qToMat(getNodeR("LeftFoot", frame), getNodeT("LeftFoot", frame)));
    const mLT = multMat(mLF, qToMat(getNodeR("LeftToeBase", frame), getNodeT("LeftToeBase", frame)));

    const mRU = multMat(mHips, qToMat(getNodeR("RightUpLeg", frame), getNodeT("RightUpLeg", frame)));
    const mRL = multMat(mRU, qToMat(getNodeR("RightLeg", frame), getNodeT("RightLeg", frame)));
    const mRF = multMat(mRL, qToMat(getNodeR("RightFoot", frame), getNodeT("RightFoot", frame)));
    const mRT = multMat(mRF, qToMat(getNodeR("RightToeBase", frame), getNodeT("RightToeBase", frame)));

    const footYs = [mLF[13], mLT[13], mRF[13], mRT[13]];
    const fMin = Math.min(...footYs);
    if (fMin < minFootY) minFootY = fMin;
  }
  return minFootY;
}

function trimAnimation(anim, framesToCut = 10) {
  const CUT_TIME = framesToCut * (1 / 30);
  for (const channel of anim.listChannels()) {
    const sampler = channel.getSampler();
    const input = sampler.getInput();
    const output = sampler.getOutput();
    if (!input || !output) continue;

    const inArr = input.getArray();
    const outArr = output.getArray();
    const targetPath = channel.getTargetPath();
    const stride = targetPath === "rotation" ? 4 : 3;

    if (inArr.length > framesToCut) {
      const cutTimeOffset = inArr[framesToCut];
      const newIn = new Float32Array(inArr.length - framesToCut);
      for (let i = 0; i < newIn.length; i++) {
        newIn[i] = Math.max(0, inArr[i + framesToCut] - cutTimeOffset);
      }
      const newOut = new Float32Array(outArr.slice(framesToCut * stride));
      input.setArray(newIn);
      output.setArray(newOut);
    } else if (inArr.length === 2) {
      const newIn = new Float32Array([0, Math.max(0.0333, inArr[1] - CUT_TIME)]);
      input.setArray(newIn);
    }
  }
}

async function main() {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

  // 1. Convert Backflip.fbx to /tmp/Backflip.glb if present
  let backflipDoc = null;
  if (existsSync("Backflip.fbx")) {
    console.log("Converting Backflip.fbx to GLB...");
    execSync(`node scripts/fbx-to-glb.mjs Backflip.fbx --out /tmp`, { stdio: "inherit" });
    if (existsSync("/tmp/Backflip.glb")) {
      backflipDoc = await io.read("/tmp/Backflip.glb");
      console.log("Loaded Backflip animation from FBX.");
    }
  }

  const characters = [
    {
      name: "BrazilianPlayer",
      raw: "raw/characters/BrazilianPlayer.glb",
      anim: "ALL_NLA_TRACKS.glb",
      out: "assets/models/characters/BrazilianPlayer.glb",
      isSpain: false,
    },
    {
      name: "EnglishPlayer",
      raw: "raw/characters/EnglishPlayer.glb",
      anim: "ALL_NLA_TRACKS_English.glb",
      out: "assets/models/characters/EnglishPlayer.glb",
      isSpain: false,
    },
    {
      name: "FrenchPlayer",
      raw: "raw/characters/FrenchPlayer.glb",
      anim: null, // Keep original France animations
      out: "assets/models/characters/FrenchPlayer.glb",
      isSpain: false,
    },
    {
      name: "SpanishPlayer",
      raw: "raw/characters/SpanishPlayer.glb",
      anim: "ALL_NLA_TRACKS_Spain.glb",
      out: "assets/models/characters/SpanishPlayer.glb",
      isSpain: true,
    },
  ];

  for (const char of characters) {
    console.log(`\n========================================`);
    console.log(`Processing ${char.name}...`);
    if (!existsSync(char.raw)) {
      console.warn(`Raw file not found: ${char.raw}`);
      continue;
    }

    const doc = await io.read(char.raw);
    const targetNodeMap = new Map();
    for (const node of doc.getRoot().listNodes()) {
      targetNodeMap.set(node.getName().trim(), node);
    }
    const buffer = doc.getRoot().listBuffers()[0] || doc.createBuffer();

    if (char.anim && existsSync(char.anim)) {
      const animDoc = await io.read(char.anim);
      const anims = animDoc.getRoot().listAnimations();

      // Remove existing animations
      for (const oldAnim of doc.getRoot().listAnimations()) {
        oldAnim.dispose();
      }

      const idleMinFootY = computeMinFootY(animDoc, "Idle", 0) ?? 0.03;
      console.log(`  Reference Idle lowest foot Y: ${idleMinFootY.toFixed(4)}`);

      for (const srcAnim of anims) {
        const animName = srcAnim.getName().trim();
        if (animName === "PointWinning") {
          console.log(`  Skipping deformed animation: ${animName}`);
          continue;
        }
        const newAnim = doc.createAnimation(animName);

        let hipsYOffset = 0;
        if (animName.startsWith("Stunt")) {
          const stuntMinFootY = computeMinFootY(animDoc, animName, 0);
          if (stuntMinFootY !== null && stuntMinFootY < idleMinFootY) {
            hipsYOffset = idleMinFootY - stuntMinFootY;
            console.log(`  Grounded ${animName}: raw foot min=${stuntMinFootY.toFixed(4)} -> adjusted Hips Y +${hipsYOffset.toFixed(4)}`);
          }
        }

        for (const srcChannel of srcAnim.listChannels()) {
          const srcTargetNode = srcChannel.getTargetNode();
          if (!srcTargetNode) continue;
          const tgtNode = targetNodeMap.get(srcTargetNode.getName().trim());
          if (!tgtNode) continue;

          const srcSampler = srcChannel.getSampler();
          const srcInput = srcSampler.getInput();
          const srcOutput = srcSampler.getOutput();

          const srcInArr = srcInput.getArray();
          const srcOutArr = srcOutput.getArray();

          const outCopy = new Float32Array(srcOutArr.buffer.slice(srcOutArr.byteOffset, srcOutArr.byteOffset + srcOutArr.byteLength));
          if (hipsYOffset !== 0 && srcTargetNode.getName().trim() === "Hips" && srcChannel.getTargetPath() === "translation") {
            for (let i = 0; i < outCopy.length / 3; i++) {
              outCopy[i * 3 + 1] += hipsYOffset;
            }
          }

          const newInput = doc.createAccessor()
            .setArray(new Float32Array(srcInArr.buffer.slice(srcInArr.byteOffset, srcInArr.byteOffset + srcInArr.byteLength)))
            .setType(srcInput.getType())
            .setBuffer(buffer);

          const newOutput = doc.createAccessor()
            .setArray(outCopy)
            .setType(srcOutput.getType())
            .setBuffer(buffer);

          const newSampler = doc.createAnimationSampler()
            .setInput(newInput)
            .setOutput(newOutput)
            .setInterpolation(srcSampler.getInterpolation());

          const newChannel = doc.createAnimationChannel()
            .setTargetNode(tgtNode)
            .setTargetPath(srcChannel.getTargetPath())
            .setSampler(newSampler);

          newAnim.addSampler(newSampler);
          newAnim.addChannel(newChannel);
        }

        if (animName.toLowerCase() === "stunt2") {
          trimAnimation(newAnim, 10);
          console.log(`  Trimmed first 10 frames from ${animName}`);
        }
      }
    }

    // Reset root node offset if present in raw model so all characters spawn at origin (0, 0, 0)
    for (const node of doc.getRoot().listNodes()) {
      if (node.getName() === char.name || (!node.getParentNode() && node.getName().includes("Player"))) {
        console.log(`  Reset root node "${node.getName()}" translation to [0, 0, 0]`);
        node.setTranslation([0, 0, 0]);
      }
    }

    // Retarget Backflip from FBX only to BrazilianPlayer as MenuPose_Backflip
    if (backflipDoc && char.name === "BrazilianPlayer") {
      const fbxAnim = backflipDoc.getRoot().listAnimations()[0];
      if (fbxAnim) {
        console.log(`  Retargeting Backflip from FBX to ${char.name}...`);
        const newBackflip = doc.createAnimation("MenuPose_Backflip");

        const scaleMul = 0.01;
        const groundOffset = 0.05;

        for (const srcChannel of fbxAnim.listChannels()) {
          const srcTargetNode = srcChannel.getTargetNode();
          if (!srcTargetNode) continue;
          const cleanNodeName = srcTargetNode.getName().trim().replace(/^mixamorig\d*:/, "");
          const tgtNode = targetNodeMap.get(cleanNodeName);
          if (!tgtNode) continue;

          // Only allow translation on Hips (skeletal rotations on all others)
          if (srcChannel.getTargetPath() === "translation" && cleanNodeName !== "Hips") continue;
          if (srcChannel.getTargetPath() === "scale") continue;

          const srcSampler = srcChannel.getSampler();
          const srcInput = srcSampler.getInput();
          const srcOutput = srcSampler.getOutput();

          const srcInArr = srcInput.getArray();
          const srcOutArr = srcOutput.getArray();

          const outCopy = new Float32Array(srcOutArr.buffer.slice(srcOutArr.byteOffset, srcOutArr.byteOffset + srcOutArr.byteLength));
          if (cleanNodeName === "Hips" && srcChannel.getTargetPath() === "translation") {
            const startX = outCopy[0];
            const startZ = outCopy[2];
            for (let i = 0; i < outCopy.length / 3; i++) {
              outCopy[i * 3] = (outCopy[i * 3] - startX) * scaleMul;
              outCopy[i * 3 + 1] = outCopy[i * 3 + 1] * scaleMul + groundOffset;
              outCopy[i * 3 + 2] = (outCopy[i * 3 + 2] - startZ) * scaleMul;
            }
          }

          const newInput = doc.createAccessor()
            .setArray(new Float32Array(srcInArr.buffer.slice(srcInArr.byteOffset, srcInArr.byteOffset + srcInArr.byteLength)))
            .setType(srcInput.getType())
            .setBuffer(buffer);

          const newOutput = doc.createAccessor()
            .setArray(outCopy)
            .setType(srcOutput.getType())
            .setBuffer(buffer);

          const newSampler = doc.createAnimationSampler()
            .setInput(newInput)
            .setOutput(newOutput)
            .setInterpolation(srcSampler.getInterpolation());

          const newChannel = doc.createAnimationChannel()
            .setTargetNode(tgtNode)
            .setTargetPath(srcChannel.getTargetPath())
            .setSampler(newSampler);

          newBackflip.addSampler(newSampler);
          newBackflip.addChannel(newChannel);
        }
        console.log(`  Added MenuPose_Backflip with ${newBackflip.listChannels().length} retargeted channels.`);
      }
    }

    // Ensure PointWinning is stripped from any model
    for (const anim of doc.getRoot().listAnimations()) {
      if (anim.getName().trim() === "PointWinning") {
        console.log(`  Disposed deformed animation ${anim.getName()} from ${char.name}`);
        anim.dispose();
      }
    }

    const tempMerged = `/tmp/${char.name}_merged.glb`;
    await io.write(tempMerged, doc);
    console.log(`Merged animations into ${tempMerged}. Running pack-model.sh...`);

    // Run standard pack-model.sh
    execSync(`sh scripts/pack-model.sh "${tempMerged}" "${char.out}" 1024`, { stdio: "inherit" });
    rmSync(tempMerged, { force: true });
    console.log(`Successfully packed ${char.out}!`);
  }

  // Also pack animations.glb (Brazil base)
  console.log("\n========================================\nPacking standalone animations.glb...");
  if (existsSync("ALL_NLA_TRACKS.glb")) {
    const animsDoc = await io.read("ALL_NLA_TRACKS.glb");
    for (const anim of animsDoc.getRoot().listAnimations()) {
      if (anim.getName().trim() === "PointWinning") {
        console.log(`  Disposed deformed animation ${anim.getName()} from animations.glb`);
        anim.dispose();
      } else if (anim.getName().trim().toLowerCase() === "stunt2") {
        trimAnimation(anim, 10);
        console.log(`  Trimmed first 10 frames from ${anim.getName()} in animations.glb`);
      }
    }
    const tempAnims = `/tmp/animations_cleaned.glb`;
    await io.write(tempAnims, animsDoc);
    execSync(`sh scripts/pack-model.sh "${tempAnims}" assets/models/characters/animations.glb 1024`, { stdio: "inherit" });
    rmSync(tempAnims, { force: true });
  }

  console.log("\n✅ All character models packed successfully with retargeted Backflip!");
}

main().catch(err => {
  console.error("Error in pack-characters:", err);
  process.exit(1);
});
