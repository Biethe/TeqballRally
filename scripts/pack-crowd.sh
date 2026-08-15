#!/usr/bin/env sh
# Prepare a crowd figure for shipping.
#
#   scripts/pack-crowd.sh raw/crowd/Caleb.glb assets/models/Crowd/Caleb.glb
#
# Like pack-model.sh, plus a decimation pass, because a spectator is not a
# hero character and there are several hundred of them.
#
# The figures arrive at 48-54k triangles each. The players on the court are
# about that, and there are two of them; the stands hold hundreds, thin
# instanced, so the same mesh multiplied out is the whole frame budget spent on
# people nobody is looking at. The crowd this replaces ran 1.9-2.9k triangles a
# figure, which is the number to aim near.
#
# The simplifier is meshoptimizer's, through gltf-transform. `--error` is what
# actually binds here rather than `--ratio`: past a point it refuses to collapse
# further without exceeding the error, which is the behaviour worth having —
# the figures stop losing shape rather than the count hitting an arbitrary
# target. Skin weights and the 65-joint rig survive it, which matters because
# these are baked into vertex-animation textures afterwards.
set -eu

if [ $# -lt 2 ]; then
  echo "usage: $0 <input.glb> <output.glb> [texture-limit] [simplify-error]" >&2
  exit 2
fi

IN="$1"
OUT="$2"
# 256 is generous for someone forty rows back at phone size.
LIMIT="${3:-256}"
ERROR="${4:-0.06}"
CLI="@gltf-transform/cli@4"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Simplify first: decimating before the textures are touched keeps the UV
# seams the simplifier has to preserve aligned with the maps that survive.
npx --yes "$CLI" simplify "$IN" "$TMP/a.glb" --ratio 0.015 --error "$ERROR"
# No `join` pass. These figures are six meshes split by material, which is six
# draws per spectator kind, and merging them would take the crowd from 29 draw
# calls to about 14 — but they are skinned, and gltf-transform will not join
# meshes that carry different skins. Merging them at runtime is possible and is
# the place to try next; it is an optimisation on a crowd that renders
# correctly, so it is not worth risking one that does.
npx --yes "$CLI" resize --width "$LIMIT" --height "$LIMIT" "$TMP/a.glb" "$TMP/b.glb"
npx --yes "$CLI" webp --quality 85 "$TMP/b.glb" "$TMP/c.glb"
npx --yes "$CLI" meshopt --level medium "$TMP/c.glb" "$OUT"

echo "$(basename "$IN"): $(du -h "$IN" | cut -f1) → $(du -h "$OUT" | cut -f1)"
