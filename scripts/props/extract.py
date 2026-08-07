"""Pull houses, trees and cars out of the three low-poly packs into one OBJ.

Each pack is a single OBJ with one `o` block per part and standard global
face indices.  The cars pack splits every vehicle into a dozen parts, so its
parts are clustered by centroid before export.  Every exported object is
recentred on its own x/z footprint and grounded on y, which is what the
placement code in surroundings.ts expects of a prop.
"""

import math
from PIL import Image
import sys
from collections import defaultdict

U = sys.argv[1] if len(sys.argv) > 1 else "."
SRC = {
    "house": f"{U}/LowPoly_House_20_Pack_obj.obj",
    "tree": f"{U}/LowPoly_Tree_Collection_01_obj.obj",
    "car": f"{U}/LowPoly_Cars_01_obj.obj",
}


def load(path):
    v, vt, vn = [], [], []
    objs = []          # (name, [face as list of (vi, ti, ni)])
    cur = None
    for line in open(path, errors="ignore"):
        t, _, rest = line.partition(" ")
        if t == "v":
            v.append(tuple(float(x) for x in rest.split()[:3]))
        elif t == "vt":
            p = rest.split()
            vt.append((float(p[0]), float(p[1]) if len(p) > 1 else 0.0))
        elif t == "vn":
            vn.append(tuple(float(x) for x in rest.split()[:3]))
        elif t in ("o", "g"):
            cur = (rest.strip(), [])
            objs.append(cur)
        elif t == "f" and cur is not None:
            face = []
            for tok in rest.split():
                parts = (tok.split("/") + ["", ""])[:3]
                idx = []
                for i, p in enumerate(parts):
                    if not p:
                        idx.append(0)
                        continue
                    n = int(p)
                    if n < 0:
                        n = [len(v), len(vt), len(vn)][i] + 1 + n
                    idx.append(n)
                face.append(tuple(idx))
            cur[1].append(face)
    return v, vt, vn, objs


def bounds(v, faces):
    lo = [math.inf] * 3
    hi = [-math.inf] * 3
    for f in faces:
        for vi, _, _ in f:
            p = v[vi - 1]
            for i in range(3):
                lo[i] = min(lo[i], p[i])
                hi[i] = max(hi[i], p[i])
    return lo, hi


class Writer:
    def __init__(self, path):
        self.f = open(path, "w")
        self.f.write("mtllib props.mtl\nusemtl props\n")
        self.base = [0, 0, 0]

    def add(self, name, v, vt, vn, faces):
        lo, hi = bounds(v, faces)
        # Recentre on the footprint, sit on the ground.
        off = (-(lo[0] + hi[0]) / 2, -lo[1], -(lo[2] + hi[2]) / 2)
        maps = [{}, {}, {}]
        out_v, out_t, out_n, out_f = [], [], [], []
        for face in faces:
            row = []
            for vi, ti, ni in face:
                if vi not in maps[0]:
                    p = v[vi - 1]
                    out_v.append((p[0] + off[0], p[1] + off[1], p[2] + off[2]))
                    maps[0][vi] = len(out_v)
                if ti and ti not in maps[1]:
                    out_t.append(vt[ti - 1])
                    maps[1][ti] = len(out_t)
                if ni and ni not in maps[2]:
                    out_n.append(vn[ni - 1])
                    maps[2][ni] = len(out_n)
                row.append((maps[0][vi],
                            maps[1][ti] if ti else 0,
                            maps[2][ni] if ni else 0))
            out_f.append(row)
        w = self.f.write
        w(f"o {name}\n")
        for p in out_v:
            w("v %.5f %.5f %.5f\n" % p)
        for p in out_t:
            w("vt %.5f %.5f\n" % p)
        for p in out_n:
            w("vn %.4f %.4f %.4f\n" % p)
        for face in out_f:
            w("f " + " ".join(
                "%d/%s/%s" % (a + self.base[0],
                              str(b + self.base[1]) if b else "",
                              str(c + self.base[2]) if c else "")
                for a, b, c in face) + "\n")
        self.base[0] += len(out_v)
        self.base[1] += len(out_t)
        self.base[2] += len(out_n)
        return (hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]), len(out_f)

    def close(self):
        self.f.close()


ATLAS = Image.open("color.jpg").convert("RGB")
ATLAS_PX = ATLAS.load()


def greenness(vt, faces):
    """Fraction of an object's vertices whose palette colour is green.

    Every pack in this set is coloured by one atlas of flat swatches, so a
    model's colour is entirely a question of which swatches its UVs land in.
    """
    w, h = ATLAS.size
    green = 0
    total = 0
    for face in faces:
        for _, ti, _ in face:
            if not ti:
                continue
            u, y = vt[ti - 1]
            # OBJ's V runs up from the bottom of the image, the image's rows
            # run down from the top. Without the flip every sample lands in
            # the wrong swatch and nothing measures green at all.
            r, g, b = ATLAS_PX[int((u % 1.0) * (w - 1)),
                               int(((1 - y) % 1.0) * (h - 1))]
            total += 1
            if g > r * 1.15 and g > b * 1.15:
                green += 1
    return green / total if total else 0


def centroid(v, faces):
    lo, hi = bounds(v, faces)
    return ((lo[0] + hi[0]) / 2, (lo[2] + hi[2]) / 2)


def cluster_cars(v, objs, reach=2.2):
    """Grow clusters of parts whose footprint centres sit within `reach`."""
    cents = [centroid(v, f) for _, f in objs]
    seen = [False] * len(objs)
    out = []
    for i in range(len(objs)):
        if seen[i]:
            continue
        seen[i] = True
        group = [i]
        queue = [i]
        while queue:
            a = queue.pop()
            for j in range(len(objs)):
                if seen[j]:
                    continue
                dx = cents[a][0] - cents[j][0]
                dz = cents[a][1] - cents[j][1]
                if dx * dx + dz * dz <= reach * reach:
                    seen[j] = True
                    group.append(j)
                    queue.append(j)
        faces = [f for g in group for f in objs[g][1]]
        out.append(faces)
    return out


def main():
    out = {k: Writer(f"g_{k}.obj") for k in SRC}
    report = defaultdict(list)

    v, vt, vn, objs = load(SRC["house"])
    for n, (_, faces) in enumerate(objs, 1):
        report["house"].append(out["house"].add(f"house_{n}", v, vt, vn, faces))

    v, vt, vn, objs = load(SRC["tree"])
    # 200 trees is far more variety than a skyline needs; take the largest
    # distinct ones, which are the full canopies rather than the saplings.
    # Bare ones are dropped: the pack mixes leafless winter trees in with the
    # rest, and a dead tree in a summer park reads as a mistake rather than
    # variety. Greenness comes from the palette they sample, since that is
    # where all their colour lives.
    leafy = [o for o in objs if len(o[1]) > 180 and greenness(vt, o[1]) > 0.58]
    leafy.sort(key=lambda o: -len(o[1]))
    leafy = leafy[:14]
    for n, (_, faces) in enumerate(leafy, 1):
        report["tree"].append(out["tree"].add(f"tree_{n}", v, vt, vn, faces))

    v, vt, vn, objs = load(SRC["car"])
    # A tight reach keeps a cluster to one vehicle: parked cars in this pack
    # sit close enough nose-to-tail that a generous radius merges two of them.
    picked = []
    seen_shape = set()
    for faces in sorted(cluster_cars(v, objs, 1.35), key=len, reverse=True):
        if len(faces) < 300:
            continue
        lo, hi = bounds(v, faces)
        d = [hi[i] - lo[i] for i in range(3)]
        span = max(d[0], d[2])
        if span > 6.5 or d[1] > 3.0 or span < 3.0:
            continue                        # two cars merged, or a stray part
        key = (round(span, 1), round(d[1], 1), len(faces))
        if key in seen_shape:
            continue                        # the pack repeats several models
        seen_shape.add(key)
        picked.append(faces)
    for n, faces in enumerate(picked[:8], 1):
        report["car"].append(out["car"].add(f"car_{n}", v, vt, vn, faces))

    for k, w in out.items():
        w.close()
        dims = report[k]
        print(k, len(dims), "objects,",
              sum(d[1] for d in dims), "faces")
        for i, (d, f) in enumerate(dims, 1):
            print("   %s_%d  %.2f x %.2f x %.2f  %d faces"
                  % (k, i, d[0], d[1], d[2], f))


main()
