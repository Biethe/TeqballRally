// Convert FBX to glB, without Blender.
//
// The crowd source arrives as binary FBX, and nothing in this repo reads FBX at
// runtime. There is no Blender on this machine either — but assimp does read
// FBX, and assimpjs is assimp compiled to WebAssembly, which is the same route
// the crowd figures already took out of Collada (see extract-crowd-figure.py).
//
//   node scripts/fbx-to-glb.mjs raw/crowd                 # a whole folder
//   node scripts/fbx-to-glb.mjs raw/crowd/character.fbx   # one file
//   node scripts/fbx-to-glb.mjs <in> --out raw/crowd-glb
//
// The output is a *raw* export: full-size textures, no mesh compression, and
// it belongs in raw/ like every other export. Run scripts/pack-model.sh over it
// before anything ships — a straight export is the thing that makes a 40 MB
// model, not the art.
//
// Textures: a binary FBX usually keeps its images inside itself, but some
// exporters write them beside the file in a `<name>.fbm` folder instead. Those
// are fed in alongside, because assimp resolves them by the name the FBX
// records and will otherwise export a model with no maps at all.
import assimpjsInit from "assimpjs";
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, existsSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";

const args = process.argv.slice(2);
const outFlag = args.indexOf("--out");
const outDir = outFlag >= 0 ? args[outFlag + 1] : null;
const inputs = args.filter((a, i) => !a.startsWith("--") && i !== outFlag + 1);

if (inputs.length === 0) {
  console.error("usage: node scripts/fbx-to-glb.mjs <file.fbx|dir> [--out <dir>]");
  process.exit(2);
}

/** Every .fbx under a path, whether it is one file or a folder of them. */
function fbxFiles(target) {
  const path = resolve(target);
  if (!existsSync(path)) throw new Error(`no such path: ${target}`);
  if (statSync(path).isFile()) return [path];
  return readdirSync(path)
    .filter((f) => extname(f).toLowerCase() === ".fbx")
    .sort()
    .map((f) => join(path, f));
}

/** A one-line summary of what actually came through the conversion. */
function summarise(gltfJson) {
  const j = gltfJson;
  const joints = new Set();
  for (const skin of j.skins ?? []) for (const n of skin.joints ?? []) joints.add(n);
  const clips = (j.animations ?? []).map((a) => a.name || "(unnamed)");
  return {
    meshes: (j.meshes ?? []).length,
    primitives: (j.meshes ?? []).reduce((n, m) => n + (m.primitives?.length ?? 0), 0),
    nodes: (j.nodes ?? []).length,
    skins: (j.skins ?? []).length,
    joints: joints.size,
    images: (j.images ?? []).length,
    materials: (j.materials ?? []).length,
    animations: clips.length,
    clips,
  };
}

/** The JSON chunk out of a .glb, so the result can be inspected without a viewer. */
function glbJson(buffer) {
  const length = buffer.readUInt32LE(12);
  return JSON.parse(buffer.subarray(20, 20 + length).toString("utf8"));
}

const ajs = await assimpjsInit();

for (const file of inputs.flatMap(fbxFiles)) {
  const dir = outDir ?? dirname(file);
  mkdirSync(dir, { recursive: true });
  const name = basename(file, extname(file));
  const target = join(dir, `${name}.glb`);

  const list = new ajs.FileList();
  list.AddFile(basename(file), readFileSync(file));

  // Sidecar textures, if this export wrote them out rather than embedding them.
  const fbm = join(dirname(file), `${name}.fbm`);
  let sidecars = 0;
  if (existsSync(fbm) && statSync(fbm).isDirectory()) {
    for (const tex of readdirSync(fbm)) {
      // Named the way the FBX refers to them: relative to the file itself.
      list.AddFile(`${name}.fbm/${tex}`, readFileSync(join(fbm, tex)));
      sidecars++;
    }
  }

  const started = Date.now();
  const result = ajs.ConvertFileList(list, "glb2");
  if (!result.IsSuccess() || result.FileCount() === 0) {
    console.error(`FAIL ${basename(file)}: ${result.GetErrorCode()}`);
    process.exitCode = 1;
    continue;
  }

  const glb = Buffer.from(result.GetFile(0).GetContent());
  writeFileSync(target, glb);
  const s = summarise(glbJson(glb));
  const mb = (n) => (n / 1048576).toFixed(1);
  console.log(
    `${basename(file)} -> ${target}\n` +
      `   ${mb(statSync(file).size)} MB -> ${mb(glb.length)} MB in ${((Date.now() - started) / 1000).toFixed(1)}s` +
      (sidecars ? `, ${sidecars} sidecar textures` : "") +
      `\n   meshes ${s.meshes} (${s.primitives} prims) · nodes ${s.nodes} · skins ${s.skins}` +
      ` · joints ${s.joints} · materials ${s.materials} · images ${s.images}` +
      `\n   animations ${s.animations}${s.clips.length ? `: ${s.clips.slice(0, 6).join(", ")}` : ""}`
  );
}
