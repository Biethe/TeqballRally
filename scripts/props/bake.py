"""Bake the palette atlas into vertex colours and drop the UVs.

The three packs share one 1024x1024 texture that is nothing but twenty colour
swatches -- every window, door and wheel in these models is geometry, not
texture detail. Sampling it per vertex is therefore lossless, and it buys two
things: the texture leaves the payload, and gltfpack's aggressive simplifier
stops smearing UVs across neighbouring swatches, which was painting rainbow
stripes along every roof edge.
"""

import json
import struct
import sys

from PIL import Image

SRC, ATLAS, DST = sys.argv[1], sys.argv[2], sys.argv[3]

img = Image.open(ATLAS).convert("RGB")
W, H = img.size
px = img.load()

raw = open(SRC, "rb").read()
json_len = struct.unpack_from("<I", raw, 12)[0]
gltf = json.loads(raw[20:20 + json_len])
bin_off = 20 + json_len + 8
bin_len = struct.unpack_from("<I", raw, 20 + json_len)[0]
blob = bytearray(raw[bin_off:bin_off + bin_len])

COMP = {5120: ("b", 1), 5121: ("B", 1), 5122: ("h", 2), 5123: ("H", 2),
        5125: ("I", 4), 5126: ("f", 4)}
COUNT = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}


def read(acc_index):
    acc = gltf["accessors"][acc_index]
    fmt, size = COMP[acc["componentType"]]
    n = COUNT[acc["type"]]
    bv = gltf["bufferViews"][acc["bufferView"]]
    base = bv.get("byteOffset", 0) + acc.get("byteOffset", 0)
    stride = bv.get("byteStride") or size * n
    out = []
    for i in range(acc["count"]):
        out.append(struct.unpack_from("<" + fmt * n, blob, base + i * stride))
    return out


# The atlas is sampled and written straight through, with no sRGB-to-linear
# conversion. That is wrong by the glTF spec, which calls COLOR_0 linear, and
# right for this game: the props are drawn with a StandardMaterial, which
# multiplies vertex colours into a gamma-space pipeline and outputs them
# unconverted. Converting here and rendering there darkens every prop twice.
def sample(u, v):
    # glTF UV origin is the image's top-left corner, matching Pillow's.
    x = (u - int(u) + 1) % 1.0 * (W - 1)
    y = (v - int(v) + 1) % 1.0 * (H - 1)
    return px[int(x), int(y)]


def add_view(data):
    while len(blob) % 4:
        blob.append(0)
    off = len(blob)
    blob.extend(data)
    gltf["bufferViews"].append({"buffer": 0, "byteOffset": off,
                                "byteLength": len(data), "target": 34962})
    return len(gltf["bufferViews"]) - 1


def align_winding(prim):
    """Wind every triangle to agree with the normals it already carries.

    The packs are modelled to be rendered double sided and their winding shows
    it: a good third of the faces in the house models are wound inward. That
    is invisible under a double-sided material until you try to *light* it,
    at which point every disagreeing face goes black, because two-sided
    lighting flips the normal on the side the camera is not on -- and which
    side that is comes from the winding.

    Flipping the triangles rather than the normals is what keeps the fix
    local: the normals are the artist's, including whatever smoothing they
    authored, and the winding is the thing that is already inconsistent.
    """
    if "NORMAL" not in prim["attributes"] or "indices" not in prim:
        return 0
    pos = read(prim["attributes"]["POSITION"])
    nrm = read(prim["attributes"]["NORMAL"])
    acc = gltf["accessors"][prim["indices"]]
    fmt, size = COMP[acc["componentType"]]
    bv = gltf["bufferViews"][acc["bufferView"]]
    base = bv.get("byteOffset", 0) + acc.get("byteOffset", 0)
    idx = list(struct.unpack_from("<" + fmt * acc["count"], blob, base))
    flipped = 0
    for t in range(0, len(idx) - 2, 3):
        a, b, c = idx[t], idx[t + 1], idx[t + 2]
        pa, pb, pc = pos[a], pos[b], pos[c]
        u = (pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2])
        v = (pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2])
        face = (u[1] * v[2] - u[2] * v[1],
                u[2] * v[0] - u[0] * v[2],
                u[0] * v[1] - u[1] * v[0])
        stored = [(nrm[a][i] + nrm[b][i] + nrm[c][i]) for i in range(3)]
        if sum(face[i] * stored[i] for i in range(3)) < 0:
            idx[t + 1], idx[t + 2] = c, b
            flipped += 1
    struct.pack_into("<" + fmt * acc["count"], blob, base, *idx)
    return flipped


baked = 0
rewound = 0
for mesh in gltf["meshes"]:
    for prim in mesh["primitives"]:
        rewound += align_winding(prim)
        uv_index = prim["attributes"].pop("TEXCOORD_0", None)
        if uv_index is None:
            continue
        uvs = read(uv_index)
        data = bytearray()
        for u, v in uvs:
            r, g, b = sample(u, v)
            data.extend((r, g, b, 255))
        view = add_view(bytes(data))
        gltf["accessors"].append({"bufferView": view, "componentType": 5121,
                                  "normalized": True, "count": len(uvs),
                                  "type": "VEC4"})
        prim["attributes"]["COLOR_0"] = len(gltf["accessors"]) - 1
        baked += 1

for mat in gltf.get("materials", []):
    pbr = mat.setdefault("pbrMetallicRoughness", {})
    pbr.pop("baseColorTexture", None)
    pbr["baseColorFactor"] = [1, 1, 1, 1]
    pbr["metallicFactor"] = 0
    pbr["roughnessFactor"] = 0.85
for key in ("textures", "images", "samplers"):
    gltf.pop(key, None)

gltf["buffers"] = [{"byteLength": len(blob)}]
text = json.dumps(gltf).encode("utf8")
text += b" " * (-len(text) % 4)
blob.extend(b"\0" * (-len(blob) % 4))
out = (b"glTF" + struct.pack("<II", 2, 12 + 8 + len(text) + 8 + len(blob))
       + struct.pack("<I", len(text)) + b"JSON" + text
       + struct.pack("<I", len(blob)) + b"BIN\0" + bytes(blob))
open(DST, "wb").write(out)
print(f"{DST}: baked {baked} primitives, rewound {rewound} triangles, {len(out)} bytes")
