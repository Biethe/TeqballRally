// Merge the three prop GLBs into one. They come out of the same pipeline
// with the same single material and atlas, so the merge collapses materials,
// textures and images down to the first file's copy.
import fs from "node:fs";

const inputs = process.argv.slice(2, -1);
const outPath = process.argv.at(-1);

function readGlb(path) {
  const b = fs.readFileSync(path);
  const jsonLen = b.readUInt32LE(12);
  const json = JSON.parse(b.subarray(20, 20 + jsonLen).toString("utf8"));
  const binStart = 20 + jsonLen + 8;
  const binLen = b.readUInt32LE(20 + jsonLen);
  return { json, bin: b.subarray(binStart, binStart + binLen) };
}

const out = {
  asset: { version: "2.0", generator: "props-merge" },
  scene: 0,
  scenes: [{ nodes: [] }],
  nodes: [],
  meshes: [],
  accessors: [],
  bufferViews: [],
  materials: [],
  textures: [],
  images: [],
  samplers: [],
  buffers: [],
};
const chunks = [];
let binLen = 0;

for (const path of inputs) {
  const { json, bin } = readGlb(path);
  const viewBase = out.bufferViews.length;
  const accBase = out.accessors.length;
  const meshBase = out.meshes.length;
  const nodeBase = out.nodes.length;

  for (const bv of json.bufferViews) {
    const copy = { ...bv, buffer: 0, byteOffset: binLen + (bv.byteOffset ?? 0) };
    out.bufferViews.push(copy);
  }
  const pad = (4 - (bin.length % 4)) % 4;
  chunks.push(bin, Buffer.alloc(pad));
  binLen += bin.length + pad;

  for (const a of json.accessors) {
    const copy = { ...a };
    if (copy.bufferView !== undefined) copy.bufferView += viewBase;
    out.accessors.push(copy);
  }
  // First file contributes the material/texture/image; the rest reuse it.
  if (out.materials.length === 0) {
    for (const m of json.materials ?? []) out.materials.push(m);
    for (const t of json.textures ?? []) out.textures.push(t);
    for (const i of json.images ?? []) {
      const copy = { ...i };
      if (copy.bufferView !== undefined) copy.bufferView += viewBase;
      out.images.push(copy);
    }
    for (const s of json.samplers ?? []) out.samplers.push(s);
  }
  for (const m of json.meshes) {
    out.meshes.push({
      ...m,
      primitives: m.primitives.map((p) => {
        const q = { ...p, attributes: {}, material: 0 };
        for (const [k, v] of Object.entries(p.attributes)) q.attributes[k] = v + accBase;
        if (p.indices !== undefined) q.indices = p.indices + accBase;
        return q;
      }),
    });
  }
  for (const n of json.nodes) {
    const copy = { ...n };
    if (copy.mesh !== undefined) copy.mesh += meshBase;
    if (copy.children) copy.children = copy.children.map((c) => c + nodeBase);
    out.nodes.push(copy);
  }
  for (const r of json.scenes[json.scene ?? 0].nodes) out.scenes[0].nodes.push(r + nodeBase);
}

out.buffers.push({ byteLength: binLen });
if (out.samplers.length === 0) delete out.samplers;

const bin = Buffer.concat(chunks);
let jsonText = JSON.stringify(out);
while (jsonText.length % 4) jsonText += " ";
const jsonBuf = Buffer.from(jsonText, "utf8");
const header = Buffer.alloc(12);
header.write("glTF", 0, "ascii");
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + bin.length, 8);
const jc = Buffer.alloc(8);
jc.writeUInt32LE(jsonBuf.length, 0);
jc.write("JSON", 4, "ascii");
const bc = Buffer.alloc(8);
bc.writeUInt32LE(bin.length, 0);
bc.write("BIN\0", 4, "ascii");
fs.writeFileSync(outPath, Buffer.concat([header, jc, jsonBuf, bc, bin]));
console.log(outPath, "nodes", out.nodes.length, "meshes", out.meshes.length,
  "materials", out.materials.length, "images", out.images.length,
  "bytes", fs.statSync(outPath).size);
