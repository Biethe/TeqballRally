#!/usr/bin/env sh
# Prepare a venue backdrop for shipping.
#
#   scripts/pack-arena.sh raw/Basketball.glb assets/models/Arena/Basketball.glb
#
# The three outdoor arenas arrived as ~7 MB of uncompressed geometry each,
# split into 400-720 meshes over 15-21 materials. The flags below are the whole
# difference between that and ~1.2 MB in 21 draw calls:
#
#   -cc   EXT_meshopt_compression, which the game already decodes locally
#         (see MeshoptCompression.Configuration in src/scene.ts). This is what
#         takes 7 MB to 1 MB.
#   -mm   Merge everything shareable into one mesh per material. Without it
#         gltfpack instead points many nodes at one shared mesh, which the
#         runtime merge in `mergeByMaterial` has to skip — disposing a mesh
#         that has instances would take the instances with it — leaving ~200
#         draw calls instead of ~20.
#   -km   Keep material names. `hideMaterials` in src/venue.ts identifies
#         scenery to drop by material, and after -mm that is the only name
#         left to identify anything by.
#
# Not used: -noq (quantisation is invisible at these sizes and halves the
# file), -si (simplification; the triangle count is not the problem here).
#
# Check the result with `node scripts/venue-shots.mjs` — it counts real draw
# calls and saves a picture of each venue, which is the only way to know a
# rewritten GLB still renders what it used to.
set -eu

if [ $# -ne 2 ]; then
  echo "usage: $0 <input.glb> <output.glb>" >&2
  exit 2
fi

npx --yes gltfpack -i "$1" -o "$2" -cc -mm -km
ls -l "$2"
