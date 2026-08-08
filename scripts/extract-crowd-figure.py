"""Pull one rigged figure out of the 435 MB crowd Collada into a small DAE.

The pack's DAE carries geometry, skin weights and a full joint hierarchy with
rest poses, but two of its float arrays were exported empty: the controller's
inverse bind matrices and every animation output. The animation is gone for
good; the inverse bind matrices are not, because they are just the inverses of
each joint's world matrix at bind time, and the joint hierarchy still has the
local matrices needed to compute them. This writes them back so a normal
Collada importer can bind the skin.

    python3 scripts/extract-crowd-figure.py Tribune_ani_cman0350m4_ANI_00001 figure.dae

Then convert and inspect the result:

    node conv.mjs figure.dae fig            # assimpjs, DAE -> glTF
    gltfpack -i figure.gltf -o figure.glb -noq -kn
    cp figure.glb assets/models/Crowd/_rigtest.glb
    npm run dev                             # then open /rigtest.html

The source pack is not in the repository (its licence forbids redistributing
the models in a usable 3D format), so this reads it from the scratchpad path
below; point SRC at wherever the DAE actually is.
"""

import re
import sys

SRC = ("/tmp/claude-0/-home-user-TeqballRally/ba4a9bc4-9b74-5c5b-bfd6-85eec6fc7ba3"
       "/scratchpad/crowd/95 Pieces Cheering Animated People Pack.dae")


def mat_mul(a, b):
    """Row-major 4x4 multiply."""
    out = [0.0] * 16
    for r in range(4):
        for c in range(4):
            out[r * 4 + c] = sum(a[r * 4 + k] * b[k * 4 + c] for k in range(4))
    return out


def mat_inverse(m):
    """General 4x4 inverse by Gauss-Jordan; joint matrices include scale."""
    a = [list(m[r * 4:r * 4 + 4]) + [1.0 if r == c else 0.0 for c in range(4)]
         for r in range(4)]
    for col in range(4):
        piv = max(range(col, 4), key=lambda r: abs(a[r][col]))
        if abs(a[piv][col]) < 1e-12:
            raise ValueError("singular joint matrix")
        a[col], a[piv] = a[piv], a[col]
        f = a[col][col]
        a[col] = [x / f for x in a[col]]
        for r in range(4):
            if r == col:
                continue
            f = a[r][col]
            if f:
                a[r] = [x - f * y for x, y in zip(a[r], a[col])]
    return [x for r in range(4) for x in a[r][4:]]


def colour_for(material, rng):
    """A colour per body part, keyed off the pack's material names.

    The pack ships one material per part (Hair, Head, Eyes_Mouth, Skin,
    Cloths_Stuff) with textures this project does not use. Baking a flat
    colour per part into the vertices keeps every figure a single draw call
    while still reading as a person rather than a grey blob.
    """
    name = material.lower()
    if "hair" in name:
        return rng.choice([(0.12, 0.09, 0.07), (0.28, 0.18, 0.10),
                           (0.45, 0.33, 0.18), (0.55, 0.52, 0.50)])
    if "eyes" in name or "mouth" in name:
        return (0.16, 0.13, 0.12)
    if "head" in name or "skin" in name:
        return rng.choice([(0.85, 0.66, 0.52), (0.72, 0.52, 0.38),
                           (0.52, 0.36, 0.25), (0.36, 0.24, 0.17)])
    # Everything else is clothing: the crowd's colour comes from here.
    return rng.choice([(0.83, 0.24, 0.21), (0.18, 0.36, 0.72), (0.93, 0.71, 0.16),
                       (0.20, 0.55, 0.34), (0.88, 0.88, 0.90), (0.35, 0.33, 0.40),
                       (0.90, 0.45, 0.15), (0.55, 0.25, 0.60)])


def add_vertex_colours(geometry, prefix):
    """Fold the per-material split into a COLOR input on the shared vertices.

    Emitting the colour per position (rather than keeping five materials)
    means the importer produces one primitive, which is what lets the whole
    crowd draw as thin instances of a single mesh.
    """
    import random

    text = "".join(geometry)
    m = re.search(r'<float_array id="[^"]*-POSITION-array"[^>]*count="(\d+)"', text)
    if not m:
        return geometry
    n_pos = int(m.group(1)) // 3
    rng = random.Random(prefix)

    colours = [(0.6, 0.6, 0.6)] * n_pos

    def rewrite(block):
        """Give one <triangles> group a COLOR input indexed like its vertices."""
        whole, material, body = block.group(0), block.group(1), block.group(2)
        stride = max((int(o) for o in re.findall(r'offset="(\d+)"', body)), default=0) + 1
        p = re.search(r"<p>(.*?)</p>", body, re.S)
        if not p:
            return whole
        rgb = colour_for(material, rng)
        idx = p.group(1).split()
        out = []
        for i in range(0, len(idx) - stride + 1, stride):
            v = int(idx[i])
            if v < n_pos:
                colours[v] = rgb
            # Colour is per vertex, so it reuses the vertex index.
            out.extend(idx[i:i + stride])
            out.append(idx[i])
        body = body.replace(p.group(0), "<p>" + " ".join(out) + "</p>")
        body = body.replace(
            "<p>",
            f'<input semantic="COLOR" offset="{stride}" set="0" '
            f'source="#{prefix}_meshNode-COLOR"/>\n<p>', 1)
        return whole[:whole.index(">") + 1] + body + "</triangles>"

    text = re.sub(r'<triangles[^>]*material="([^"]+)"[^>]*>(.*?)</triangles>',
                  rewrite, text, flags=re.S)

    flat = " ".join(f"{c:.4f}" for rgb in colours for c in rgb)
    source = (f'<source id="{prefix}_meshNode-COLOR">\n'
              f'<float_array id="{prefix}_meshNode-COLOR-array" '
              f'count="{n_pos * 3}">{flat}</float_array>\n'
              f'<technique_common><accessor '
              f'source="#{prefix}_meshNode-COLOR-array" count="{n_pos}" stride="3">'
              f'<param name="R" type="float"/><param name="G" type="float"/>'
              f'<param name="B" type="float"/></accessor></technique_common>\n'
              f"</source>\n")
    text = text.replace("<vertices ", source + "<vertices ", 1)
    return [text]


def collect(prefix):
    """One streaming pass gathering every element this figure needs."""
    geom_id = f"{prefix}_meshNode-lib"
    root_id = f"{prefix}_skeleton_Root"

    geometry, controller, skeleton = [], [], []
    mode = None
    depth = 0
    with open(SRC, errors="ignore") as f:
        for line in f:
            if mode is None:
                if f'<geometry id="{geom_id}"' in line:
                    mode, geometry = "geom", [line]
                    continue
                if f'<skin source="#{geom_id}"' in line:
                    mode, controller = "skin", [line]
                    continue
                if f'<node id="{root_id}"' in line or f'<node name="{root_id}"' in line:
                    mode, skeleton, depth = "skel", [line], 1
                    continue
            elif mode == "geom":
                geometry.append(line)
                if "</geometry>" in line:
                    mode = None
            elif mode == "skin":
                controller.append(line)
                if "</skin>" in line:
                    mode = None
            elif mode == "skel":
                skeleton.append(line)
                depth += line.count("<node ") - line.count("</node>")
                if depth <= 0:
                    mode = None
    return geometry, controller, skeleton


def joint_world_matrices(skeleton_lines):
    """Walk the joint tree accumulating world matrices for each joint id."""
    world = {}
    stack = []
    pending_id = None
    for line in skeleton_lines:
        m = re.search(r'<node\b[^>]*\bid="([^"]+)"[^>]*type="JOINT"', line)
        if m:
            pending_id = m.group(1)
        m = re.search(r"<matrix[^>]*>([^<]+)</matrix>", line)
        if m and pending_id:
            local = [float(x) for x in m.group(1).split()]
            parent = stack[-1][1] if stack else [1.0 if i % 5 == 0 else 0.0 for i in range(16)]
            w = mat_mul(parent, local)
            world[pending_id] = w
            stack.append((pending_id, w))
            pending_id = None
        # A node closes as many levels as it ends.
        for _ in range(line.count("</node>")):
            if stack:
                stack.pop()
    return world


def main():
    prefix = sys.argv[1] if len(sys.argv) > 1 else "Tribune_ani_cman0350m4_ANI_00001"
    out_path = sys.argv[2] if len(sys.argv) > 2 else "figure.dae"

    geometry, controller, skeleton = collect(prefix)
    geometry = add_vertex_colours(geometry, prefix)
    print(f"geometry lines {len(geometry)}, skin lines {len(controller)}, "
          f"skeleton lines {len(skeleton)}")
    if not (geometry and controller and skeleton):
        raise SystemExit("missing one of geometry/skin/skeleton for " + prefix)

    world = joint_world_matrices(skeleton)
    print(f"joints with world matrices: {len(world)}")

    joints_txt = ""
    grab = False
    for line in controller:
        if "Controller-Joints-array" in line:
            grab = True
            joints_txt += line.split(">", 1)[1]
            if "</Name_array>" in line:
                break
            continue
        if grab:
            joints_txt += line
            if "</Name_array>" in line:
                break
    joint_names = joints_txt.split("<")[0].split()
    print(f"skin joints: {len(joint_names)}")

    missing = [j for j in joint_names if j not in world]
    if missing:
        raise SystemExit(f"{len(missing)} skin joints absent from the skeleton, "
                         f"e.g. {missing[:3]}")

    inv = []
    for j in joint_names:
        inv.extend(mat_inverse(world[j]))
    inv_txt = " ".join(f"{v:.6f}" for v in inv)

    # Write the computed inverse bind matrices into the empty array.
    text = "".join(controller)
    text = re.sub(
        r'(<float_array id="[^"]*Controller-Matrices-array"[^>]*count=")0("[^>]*>)\s*(</float_array>)',
        lambda m: f"{m.group(1)}{len(inv)}{m.group(2)}{inv_txt}{m.group(3)}",
        text,
    )
    if f'count="{len(inv)}"' not in text:
        raise SystemExit("failed to inject inverse bind matrices")
    controller_txt = text

    doc = f"""<?xml version="1.0" encoding="utf-8"?>
<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">
  <asset><up_axis>Y_UP</up_axis></asset>
  <library_geometries>
{"".join(geometry)}  </library_geometries>
  <library_controllers>
    <controller id="{prefix}_ctrl" name="{prefix}_ctrl">
{controller_txt}    </controller>
  </library_controllers>
  <library_visual_scenes>
    <visual_scene id="scene" name="scene">
{"".join(skeleton)}      <node id="{prefix}_skinned" name="{prefix}_skinned" type="NODE">
        <instance_controller url="#{prefix}_ctrl">
          <skeleton>#{prefix}_skeleton_Root</skeleton>
        </instance_controller>
      </node>
    </visual_scene>
  </library_visual_scenes>
  <scene><instance_visual_scene url="#scene"/></scene>
</COLLADA>
"""
    with open(out_path, "w") as f:
        f.write(doc)
    print(f"wrote {out_path}: {len(doc)} bytes")


main()
