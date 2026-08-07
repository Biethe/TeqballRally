"""Pull the palms and jungle trees out of the tropical pack.

Two things make this pack different from the other three. Its LOD1 meshes are
already the right budget for background scenery, so nothing needs simplifying.
And its textures live in Unreal `.uasset` files that did not come with it --
the FBX carries a 1x1 white placeholder -- so the colour has to be invented.
It is invented from the geometry: on a palm or a broadleaf, what is near the
trunk axis is trunk and what is far from it is canopy, which is enough to get
two-tone foliage out of a single untextured mesh.

The pack's node scales are wildly inconsistent (one plant is authored at 50
units, another at 0.14), so every prop is normalised to a stated height in
metres rather than trusted.
"""

import json
import math
import struct
import sys

SRC, DST = sys.argv[1], sys.argv[2]

# name -> (output name, metres tall, trunk colour, canopy colour)
WANT = {
    "Palm01_LOD1": ("palm_1", 7.4, (0.44, 0.34, 0.22), (0.24, 0.5, 0.22)),
    "Palm02_LOD1": ("palm_2", 6.6, (0.44, 0.34, 0.22), (0.22, 0.47, 0.2)),
    "Palm03_LOD1": ("palm_3", 8.2, (0.42, 0.32, 0.21), (0.2, 0.45, 0.21)),
    "BananaTree01_LOD1": ("palm_4", 4.2, (0.35, 0.32, 0.19), (0.26, 0.52, 0.22)),
    "JungleTree01_LOD1": ("palm_5", 9.0, (0.34, 0.27, 0.19), (0.18, 0.42, 0.2)),
    "JungleTree02_LOD1": ("palm_6", 7.6, (0.34, 0.27, 0.19), (0.2, 0.44, 0.21)),
    "TropicalPlant01_LOD1": ("bush_1", 1.7, (0.3, 0.35, 0.18), (0.24, 0.5, 0.24)),
    "TropicalPlant02_LOD1": ("bush_2", 1.4, (0.3, 0.35, 0.18), (0.26, 0.52, 0.25)),
}

raw = open(SRC, "rb").read()
json_len = struct.unpack_from("<I", raw, 12)[0]
src = json.loads(raw[20:20 + json_len])
bin_off = 20 + json_len + 8
blob = raw[bin_off:bin_off + struct.unpack_from("<I", raw, 20 + json_len)[0]]

COMP = {5120: ("b", 1), 5121: ("B", 1), 5122: ("h", 2), 5123: ("H", 2),
        5125: ("I", 4), 5126: ("f", 4)}
COUNT = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}


def read(index):
    acc = src["accessors"][index]
    fmt, size = COMP[acc["componentType"]]
    n = COUNT[acc["type"]]
    bv = src["bufferViews"][acc["bufferView"]]
    base = bv.get("byteOffset", 0) + acc.get("byteOffset", 0)
    stride = bv.get("byteStride") or size * n
    return [struct.unpack_from("<" + fmt * n, blob, base + i * stride)
            for i in range(acc["count"])]


def matmul(a, b):
    return [sum(a[i + k * 4] * b[k + j * 4] for k in range(4))
            for j in range(4) for i in range(4)]


def local(node):
    if "matrix" in node:
        return node["matrix"]
    t = node.get("translation", [0, 0, 0])
    r = node.get("rotation", [0, 0, 0, 1])
    s = node.get("scale", [1, 1, 1])
    x, y, z, w = r
    rot = [
        1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0,
        2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0,
        2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0,
        0, 0, 0, 1,
    ]
    for j in range(3):
        for i in range(3):
            rot[i + j * 4] *= s[j]
    rot[12], rot[13], rot[14] = t
    return rot


# World matrix per node, from the scene roots down.
world = {}
parent_of = {}
for i, node in enumerate(src["nodes"]):
    for c in node.get("children", []):
        parent_of[c] = i


def world_of(i):
    if i in world:
        return world[i]
    m = local(src["nodes"][i])
    if i in parent_of:
        m = matmul(world_of(parent_of[i]), m)
    world[i] = m
    return m


def apply(m, p):
    return tuple(m[i] + m[4 + i] * p[1] + m[8 + i] * p[2] + m[i] * 0 for i in range(0))


def transform(m, p):
    x, y, z = p
    return (m[0] * x + m[4] * y + m[8] * z + m[12],
            m[1] * x + m[5] * y + m[9] * z + m[13],
            m[2] * x + m[6] * y + m[10] * z + m[14])


def rotate(m, p):
    x, y, z = p
    return (m[0] * x + m[4] * y + m[8] * z,
            m[1] * x + m[5] * y + m[9] * z,
            m[2] * x + m[6] * y + m[10] * z)


out = {
    "asset": {"version": "2.0", "generator": "trop"},
    "scene": 0, "scenes": [{"nodes": []}], "nodes": [], "meshes": [],
    "accessors": [], "bufferViews": [],
    "materials": [{"name": "props", "pbrMetallicRoughness": {
        "baseColorFactor": [1, 1, 1, 1], "metallicFactor": 0,
        "roughnessFactor": 0.85}}],
    "buffers": [],
}
data = bytearray()


def view(payload, target):
    while len(data) % 4:
        data.append(0)
    off = len(data)
    data.extend(payload)
    out["bufferViews"].append({"buffer": 0, "byteOffset": off,
                               "byteLength": len(payload), "target": target})
    return len(out["bufferViews"]) - 1


def accessor(payload, target, comp, kind, count, extra=None):
    acc = {"bufferView": view(payload, target), "componentType": comp,
           "count": count, "type": kind}
    if extra:
        acc.update(extra)
    out["accessors"].append(acc)
    return len(out["accessors"]) - 1


made = 0
for index, node in enumerate(src["nodes"]):
    if node.get("name") not in WANT or node.get("mesh") is None:
        continue
    name, height, trunk, canopy = WANT[node["name"]]
    m = world_of(index)
    prim = src["meshes"][node["mesh"]]["primitives"][0]
    pos = [transform(m, p) for p in read(prim["attributes"]["POSITION"])]
    nrm = ([rotate(m, p) for p in read(prim["attributes"]["NORMAL"])]
           if "NORMAL" in prim["attributes"] else None)
    idx = [i[0] for i in read(prim["indices"])]

    lo = [min(p[i] for p in pos) for i in range(3)]
    hi = [max(p[i] for p in pos) for i in range(3)]
    scale = height / max(1e-6, hi[1] - lo[1])
    cx, cz = (lo[0] + hi[0]) / 2, (lo[2] + hi[2]) / 2
    pos = [((p[0] - cx) * scale, (p[1] - lo[1]) * scale, (p[2] - cz) * scale)
           for p in pos]

    # Trunk near the axis, canopy away from it, with a soft crossover so the
    # join does not read as a band.
    reach = max(1e-6, max(math.hypot(p[0], p[2]) for p in pos))
    top = max(p[1] for p in pos)
    colours = bytearray()
    for p in pos:
        r = math.hypot(p[0], p[2]) / reach
        t = min(1.0, max(0.0, (r - 0.06) / 0.22))
        # Nothing low down is canopy: it stops a wide trunk base going green.
        t *= min(1.0, max(0.0, (p[1] / top - 0.12) / 0.25))
        for a, b in zip(trunk, canopy):
            # Written straight through: the game draws props with a
            # StandardMaterial, which is gamma-space, so these stay sRGB.
            c = a + (b - a) * t
            colours.append(max(0, min(255, round(c * 255))))
        colours.append(255)

    attrs = {
        "POSITION": accessor(b"".join(struct.pack("<3f", *p) for p in pos),
                             34962, 5126, "VEC3", len(pos),
                             {"min": [min(p[i] for p in pos) for i in range(3)],
                              "max": [max(p[i] for p in pos) for i in range(3)]}),
        "COLOR_0": accessor(bytes(colours), 34962, 5121, "VEC4", len(pos),
                            {"normalized": True}),
    }
    if nrm:
        unit = []
        for n in nrm:
            length = math.sqrt(n[0] ** 2 + n[1] ** 2 + n[2] ** 2) or 1
            unit.append((n[0] / length, n[1] / length, n[2] / length))
        attrs["NORMAL"] = accessor(
            b"".join(struct.pack("<3f", *n) for n in unit),
            34962, 5126, "VEC3", len(unit))
    indices = accessor(b"".join(struct.pack("<I", i) for i in idx),
                       34963, 5125, "SCALAR", len(idx))

    out["meshes"].append({"name": name, "primitives": [
        {"attributes": attrs, "indices": indices, "material": 0}]})
    out["nodes"].append({"name": name, "mesh": len(out["meshes"]) - 1})
    out["scenes"][0]["nodes"].append(len(out["nodes"]) - 1)
    made += 1
    print(f"{name}: {len(idx) // 3} tris, {height} m")

out["buffers"] = [{"byteLength": len(data)}]
text = json.dumps(out).encode("utf8")
text += b" " * (-len(text) % 4)
data.extend(b"\0" * (-len(data) % 4))
glb = (b"glTF" + struct.pack("<II", 2, 12 + 8 + len(text) + 8 + len(data))
       + struct.pack("<I", len(text)) + b"JSON" + text
       + struct.pack("<I", len(data)) + b"BIN\0" + bytes(data))
open(DST, "wb").write(glb)
print(f"{DST}: {made} props, {len(glb)} bytes")
