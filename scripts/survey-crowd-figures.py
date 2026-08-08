"""Classify every rigged figure in the crowd pack as standing or seated.

One streaming pass over the 435 MB Collada, composing each joint's world
matrix from the hierarchy. Posture comes from the knee angle: a standing leg
is nearly straight, a seated one folds towards a right angle.
"""

import json
import math
import re

SRC = ("/tmp/claude-0/-home-user-TeqballRally/ba4a9bc4-9b74-5c5b-bfd6-85eec6fc7ba3"
       "/scratchpad/crowd/95 Pieces Cheering Animated People Pack.dae")
IDENTITY = [1.0 if i % 5 == 0 else 0.0 for i in range(16)]


def mat_mul(a, b):
    return [sum(a[r * 4 + k] * b[k * 4 + c] for k in range(4))
            for r in range(4) for c in range(4)]


def translation(m):
    return (m[3], m[7], m[11])


def main():
    rx_node = re.compile(r'<node\b[^>]*\bid="([^"]+)"[^>]*type="JOINT"')
    rx_mat = re.compile(r"<matrix[^>]*>([^<]+)</matrix>")
    rx_skin = re.compile(r'<skin source="#([^"]+)_meshNode-lib"')

    stack = []          # (id, world matrix)
    pending = None
    joints = {}         # figure -> {short joint name: world translation}
    skinned = set()

    for line in open(SRC, errors="ignore"):
        m = rx_skin.search(line)
        if m:
            skinned.add(m.group(1))

        m = rx_node.search(line)
        if m:
            pending = m.group(1)
        else:
            m = rx_mat.search(line)
            if m and pending:
                local = [float(x) for x in m.group(1).split()]
                parent = stack[-1][1] if stack else IDENTITY
                world = mat_mul(parent, local)
                if "_skeleton_" in pending:
                    fig, short = pending.split("_skeleton_", 1)
                    joints.setdefault(fig, {})[short] = translation(world)
                stack.append((pending, world))
                pending = None
        for _ in range(line.count("</node>")):
            if stack:
                stack.pop()

    rows = []
    for fig, js in joints.items():
        need = ("Hips", "LeftUpLeg", "LeftLeg", "LeftFoot", "Head")
        if not all(k in js for k in need):
            continue
        hip, knee, foot = js["LeftUpLeg"], js["LeftLeg"], js["LeftFoot"]
        a = [hip[i] - knee[i] for i in range(3)]
        b = [foot[i] - knee[i] for i in range(3)]
        na = math.dist(a, (0, 0, 0)) or 1e-6
        nb = math.dist(b, (0, 0, 0)) or 1e-6
        cos = sum(x * y for x, y in zip(a, b)) / (na * nb)
        angle = math.degrees(math.acos(max(-1.0, min(1.0, cos))))
        height = js["Head"][1] - min(foot[1], js["LeftFoot"][1])
        rows.append({
            "figure": fig,
            "knee_angle": round(angle, 1),
            "height": round(height, 3),
            "posture": "standing" if angle > 140 else "seated",
            "skinned": fig in skinned,
        })

    rows.sort(key=lambda r: (-r["knee_angle"], r["figure"]))
    stand = [r for r in rows if r["posture"] == "standing" and r["skinned"]]
    sit = [r for r in rows if r["posture"] == "seated" and r["skinned"]]
    print(f"figures with a skeleton: {len(rows)}   skinned: {sum(r['skinned'] for r in rows)}")
    print(f"standing (skinned): {len(stand)}   seated (skinned): {len(sit)}")
    print("\nstanding, straightest first:")
    for r in stand[:10]:
        print(f"   {r['figure']:44s} knee {r['knee_angle']:6.1f}  height {r['height']}")
    print("\nseated, most folded first:")
    for r in sorted(sit, key=lambda r: r["knee_angle"])[:10]:
        print(f"   {r['figure']:44s} knee {r['knee_angle']:6.1f}  height {r['height']}")
    json.dump(rows, open("figures.json", "w"), indent=1)
    print("\nwrote figures.json")


main()
