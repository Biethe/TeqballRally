#!/usr/bin/env bash
# Deploy the game to Firebase Hosting, in one command.
#
# The game is a static site. Testers open https://teqopen-4c7ae.web.app and
# play in the browser — no Play opt-in, no APK. The relay they talk to is the
# same Cloud Run service the Android build uses, so a hosted client and a
# phone can sit across the table from each other.
#
#   VITE_ASSET_KEY='…' ./scripts/deploy-web.sh
#
# Refuses to ship without the passphrase: a public URL that served the art in
# the clear would be exactly the redistribution the licences forbid. The key
# is baked into the JavaScript (a WebGL game has to decrypt its own assets),
# so this is not unrippable — it is the same deal as the APK, and it is the
# one this repository already made.
set -euo pipefail

PROJECT="${PROJECT:-teqopen-4c7ae}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
cd "$ROOT"

if [ -z "${VITE_ASSET_KEY:-}" ]; then
  echo "VITE_ASSET_KEY is not set — refusing to deploy the art in the clear." >&2
  echo "Set it to the release passphrase (the same GitHub Actions secret the" >&2
  echo "APK is built with) and run this again." >&2
  exit 1
fi

if [ ! -d assets/models ] || [ -z "$(ls -A assets/models 2>/dev/null)" ]; then
  echo "No art under assets/models — run \`npm run assets:fetch\` first." >&2
  exit 1
fi

echo "→ build (protected) for $PROJECT"
npm run build

# Same assertion CI makes. A successful Vite run that left a readable .glb
# in dist/ is the failure this whole scheme exists to prevent, and it looks
# exactly like a successful build.
leaked=$(find dist/models dist/textures dist/venues dist/video dist/audio \
           -type f ! -name '*.teq' ! -name '.gitkeep' 2>/dev/null || true)
if [ -n "$leaked" ]; then
  echo "These would have shipped unencrypted:" >&2
  echo "$leaked" >&2
  exit 1
fi
if [ -e dist/source-animations ]; then
  echo "Raw source animations reached dist/." >&2
  exit 1
fi

echo "→ firebase hosting ($PROJECT)"
npx --yes firebase-tools deploy --only hosting --config config/firebase.json --project "$PROJECT" --non-interactive

echo
echo "deployed: https://${PROJECT}.web.app"
echo "          https://${PROJECT}.firebaseapp.com"
