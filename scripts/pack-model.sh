#!/usr/bin/env sh
# Prepare a Blender export for shipping on a phone.
#
#   scripts/pack-model.sh raw/BrazilianPlayer.glb assets/models/characters/BrazilianPlayer.glb 1024
#   scripts/pack-model.sh raw/RedBall.glb assets/models/Ball_and_Table/RedBall.glb 512
#
# A straight glTF export from Blender ships its textures as full-size PNG and
# JPEG with no mesh compression: the four players arrived at 27-59 MB each and
# the re-done balls at 15-20 MB, against 4-8 MB and 0.5 MB for the ones they
# replaced. Nothing was wrong with the art — the export simply carries none of
# the three things that make a model downloadable.
#
# The three passes, in this order because each feeds the next:
#
#   resize  Textures come out of Blender at their authoring size — 4096 square
#           for a ball whose on-screen diameter is a couple of hundred pixels.
#           This is the single biggest win and the only lossy decision worth
#           thinking about, which is why the limit is an argument.
#   webp    PNG is the wrong container for photographic albedo and the wrong
#           one for a normal map that is 95% flat. EXT_texture_webp is already
#           how the surviving original assets are encoded, so the runtime has
#           been decoding it since before this script existed.
#   meshopt EXT_meshopt_compression plus quantisation, decoded locally by
#           MeshoptCompression.Configuration in src/scene.ts.
#
# Verified to preserve what a character needs: the skin, all 52 joints and all
# 38 animation groups survive, which `node scripts/verify-build.mjs` re-checks
# by counting skeletons and animation groups in a real browser.
#
# Keep the Blender export. Packing is lossy and not reversible, so the input
# belongs in raw/ (gitignored) and only the packed result is committed.
set -eu

if [ $# -lt 2 ]; then
  echo "usage: $0 <input.glb> <output.glb> [texture-limit]" >&2
  exit 2
fi

IN="$1"
OUT="$2"
LIMIT="${3:-1024}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

CLI="@gltf-transform/cli@4"

npx --yes "$CLI" resize --width "$LIMIT" --height "$LIMIT" "$IN" "$TMP/a.glb"
npx --yes "$CLI" webp --quality 85 "$TMP/a.glb" "$TMP/b.glb"
npx --yes "$CLI" meshopt --level medium "$TMP/b.glb" "$OUT"

echo
echo "$(basename "$IN"): $(du -h "$IN" | cut -f1) → $(du -h "$OUT" | cut -f1)"
