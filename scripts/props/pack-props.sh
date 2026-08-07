#!/usr/bin/env bash
# Build assets/models/Props/Props.glb from the four low-poly source packs.
#
# The packs are not in the repo — they are licensed downloads, and the licence
# forbids redistributing them in a form another 3D application can open. This
# script is the record of how the shipped file was made, so it can be remade
# when a pack changes; point SRC at wherever the OBJ/FBX downloads live.
#
# The pipeline, and why each step is there:
#
#   extract.py   Cars ship as 212 loose parts and trees as 200 objects, none
#                of them centred or grounded. This picks what is wanted,
#                clusters car parts back into vehicles, and puts every prop on
#                its own origin — which is what a thin instance matrix
#                assumes.
#   obj2gltf     OBJ to glTF, nothing clever.
#   bake.py      Samples the shared palette atlas into vertex colours and
#                drops the UVs and the texture, and rewinds any triangle whose
#                winding disagrees with its normal.
#   gltfpack -si Decimates houses and cars, which arrive at 3-8k triangles
#                each. Trees are already cheap and are left alone. `-sa` is
#                required: without it nothing collapses at all, because these
#                models are faceted and every edge is an attribute seam.
#   trop.py      The tropical pack separately: its LOD1 meshes are already the
#                right budget, and its textures were never shipped, so its
#                colour is derived from the geometry.
#   merge.mjs    One file, one material.
#   gltfpack -cc Meshopt compression. `-vpf` keeps positions as floats, which
#                matters at load: the game bakes each prop's transform into
#                its vertices, and quantized positions come back out of
#                `getVerticesData` as raw integers.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${OUT:-$HERE/../../assets/models/Props/Props.glb}"
WORK="${WORK:-$(mktemp -d)}"
: "${SRC:?set SRC to the directory holding the source packs}"
: "${GLTFPACK:=gltfpack}"
: "${OBJ2GLTF:=obj2gltf}"

cd "$WORK"
cp "$HERE"/*.py "$HERE"/merge.mjs .
cp "$SRC/color_1024x1024.jpg" color.jpg

python3 extract.py "$SRC"
for g in house car tree; do
  "$OBJ2GLTF" -i "g_$g.obj" -o "r_$g.glb"
  python3 bake.py "r_$g.glb" color.jpg "b_$g.glb"
done

# Ratios chosen per family: houses survive 0.28, cars 0.13, trees need none.
"$GLTFPACK" -i b_house.glb -o s_house.glb -si 0.28 -sa -kn -km -noq
"$GLTFPACK" -i b_car.glb   -o s_car.glb   -si 0.13 -sa -kn -km -noq
"$GLTFPACK" -i b_tree.glb  -o s_tree.glb  -kn -km -noq

# The tropical pack only ships as FBX.
"${FBX2GLTF:=FBX2glTF}" -i "$SRC/Stylized_Tropical_Pack_ALL.fbx" -o trop -b
python3 trop.py trop.glb t_trop.glb
"$GLTFPACK" -i t_trop.glb -o s_trop.glb -kn -km -noq

node merge.mjs s_house.glb s_tree.glb s_car.glb s_trop.glb merged.glb
"$GLTFPACK" -i merged.glb -o "$OUT" -cc -kn -km -vpf
ls -l "$OUT"
